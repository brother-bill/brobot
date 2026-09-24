import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Pokemon } from '../../../entities';
import { resolveOneVsOne, resolveTeamBattle, BATTLE_FLOURISHES } from '../../pokemon/battle/battle-resolution';
import type { Resolution } from '../../pokemon/battle/battle-resolution';
import { BattleRunner } from '../../pokemon/battle/battle-simulator';
import type { BattlePokemon } from '../../pokemon/battle/battle-simulator';
import { battleReady, isAwayInPmd, PokemonAwayError } from '../../pokemon/exclusivity';
import { PokemonWriteService } from '../../pokemon/pokemon-write.service';
import type { BattleKind } from '../../pokemon/pokemon-write.service';
import { Random } from '../../pokemon/random';
import { inSlot } from '../../pokemon/team-rules';
import { BotChatService } from '../chat/bot-chat.service';
import type { ChatUser } from '../chat/chat-types';
import { UiLinks } from '../ui-links';

/** How long a challenge waits for somebody to accept it. */
export const CHALLENGE_TTL_MS = 60_000;

const SHINY_BANNER = 'PogChamp ****SHINY**** PogChamp';

interface Challenger {
    id: string;
    login: string;
}

interface Lobby {
    challenger: Challenger | null;
    /** Set the moment somebody accepts, so a third viewer cannot join while Pokémon load. */
    accepting: boolean;
    timer: NodeJS.Timeout | null;
}

/** Why a viewer cannot fight, as chat copy (without the leading `@login, `). */
type Fighters = { ok: true; pokemon: Pokemon[] } | { ok: false; reply: string };

const COPY: Record<
    BattleKind,
    { self: string; busy: string; expired: (login: string) => string; failed: string; command: string }
> = {
    single: {
        self: "You can't battle yourself",
        busy: 'Things might have gotten spammy. Try again later',
        expired: login => `Ending pending pokemon battle for @${login}. You're simply built different`,
        failed: 'Unknown Error. Ending Battle...',
        command: '!pokemon battle',
    },
    team: {
        self: "You can't team battle yourself",
        busy: 'Things have gotten spammy. Try again later',
        expired: login => `Ending pending pokemon team battle for @${login}. Pokemon is for children`,
        failed: 'Unknown Error. Ending Team Battle...',
        command: '!pokemon teambattle',
    },
};

/**
 * `!pokemon battle` (the two starters, 1v1) and `!pokemon teambattle` (every
 * Pokémon on each team): the first viewer challenges, the next one to type
 * the same command within a minute accepts, and Pokémon Showdown decides.
 *
 * Only Pokémon at home in brobot fight (migration plan §4). A starter away in
 * PMD cannot battle; a team battle fields the rest of the team.
 */
@Injectable()
export class PokemonBattlesService implements OnModuleDestroy {
    private readonly logger = new Logger(PokemonBattlesService.name);
    private readonly lobbies: Record<BattleKind, Lobby> = {
        single: { challenger: null, accepting: false, timer: null },
        team: { challenger: null, accepting: false, timer: null },
    };

    constructor(
        private readonly chat: BotChatService,
        private readonly pokemon: PokemonWriteService,
        private readonly runner: BattleRunner,
        private readonly random: Random,
        private readonly links: UiLinks,
    ) {}

    /** A viewer typed the battle command: challenge, accept, or be told why not. */
    async command(kind: BattleKind, user: ChatUser): Promise<void> {
        const lobby = this.lobbies[kind];
        const copy = COPY[kind];
        if (!lobby.challenger) return this.challenge(kind, user);
        if (lobby.challenger.id === user.id) return this.chat.say(`${copy.self}, @${user.login}`);
        if (lobby.accepting) return this.chat.say(`How unlucky, @${user.login}. ${copy.busy}`);
        return this.accept(kind, user);
    }

    private async challenge(kind: BattleKind, user: ChatUser): Promise<void> {
        const lobby = this.lobbies[kind];
        // Claimed before the first await, as the old bot did, so two viewers
        // typing at once do not both become the challenger.
        lobby.challenger = { id: user.id, login: user.login };

        const fighters = await this.fighters(kind, user.id).catch((error: unknown) => {
            this.logger.error('Could not load a team for a battle', error instanceof Error ? error.stack : error);
            return null;
        });
        if (this.lobbies[kind] !== lobby) return;
        if (!fighters?.ok) {
            this.clear(kind);
            if (fighters) await this.chat.say(`@${user.login}, ${fighters.reply}`);
            return;
        }

        const lead = fighters.pokemon[0];
        await this.chat.say(
            kind === 'single'
                ? `@${user.login}'s Level ${lead.level} ${lead.shiny ? SHINY_BANNER : ''} ${lead.name} wants to battle! You have 1 minute to accept their challenge using the command "${COPY.single.command}"`
                : `@${user.login} wants to team battle! You have 1 minute to accept their challenge using the command "${COPY.team.command}"`,
        );
        lobby.timer = setTimeout(() => {
            if (this.lobbies[kind] !== lobby || lobby.accepting) return;
            this.clear(kind);
            void this.chat.say(COPY[kind].expired(user.login));
        }, CHALLENGE_TTL_MS);
        lobby.timer.unref();
    }

    private async accept(kind: BattleKind, user: ChatUser): Promise<void> {
        const lobby = this.lobbies[kind];
        const challenger = lobby.challenger;
        if (!challenger) return;
        lobby.accepting = true;
        try {
            const [theirs, mine] = await Promise.all([this.fighters(kind, challenger.id), this.fighters(kind, user.id)]);
            if (!theirs.ok) {
                // The challenger's Pokémon went away (deleted, or sent to PMD) since they challenged.
                this.clear(kind);
                await this.chat.say(`@${challenger.login}, ${theirs.reply}. The battle is off`);
                return;
            }
            if (!mine.ok) {
                // The challenge stays open for somebody else.
                lobby.accepting = false;
                await this.chat.say(`@${user.login}, ${mine.reply}`);
                return;
            }
            if (lobby.timer) clearTimeout(lobby.timer);
            await this.fight(kind, { login: challenger.login, pokemon: theirs.pokemon }, { login: user.login, pokemon: mine.pokemon });
        } catch (error) {
            this.logger.error(`${kind} battle failed`, error instanceof Error ? error.stack : error);
            await this.chat.say(COPY[kind].failed);
        } finally {
            // Unless the challenge was left open (or already cleared and replaced), it is over.
            if (this.lobbies[kind] === lobby && lobby.accepting) this.clear(kind);
        }
    }

    private async fight(
        kind: BattleKind,
        p1: { login: string; pokemon: Pokemon[] },
        p2: { login: string; pokemon: Pokemon[] },
    ): Promise<void> {
        const result = await this.runner.run(
            { name: p1.login, team: p1.pokemon.map(toBattlePokemon) },
            { name: p2.login, team: p2.pokemon.map(toBattlePokemon) },
        );
        await this.pokemon.saveOutcome(kind, result.log);

        const context = { detailsUrl: this.links.battleOutcome(), flourish: this.random.pick(BATTLE_FLOURISHES) };
        const resolution: Resolution =
            kind === 'single'
                ? resolveOneVsOne(
                      result,
                      { login: p1.login, pokemon: p1.pokemon[0] },
                      { login: p2.login, pokemon: p2.pokemon[0] },
                      context,
                  )
                : resolveTeamBattle(result, p1, p2, context);
        if (result.outcome.kind === 'unknown') {
            this.logger.warn(`Unreadable ${kind} battle result (${result.outcome.reason}): ${result.log.at(-1) ?? ''}`);
        }
        await this.pokemon.applyBattle(resolution.changes);
        for (const message of resolution.messages) await this.chat.say(message);
    }

    /** The Pokémon a viewer would fight with, or the reason they cannot. */
    private async fighters(kind: BattleKind, oauthId: string): Promise<Fighters> {
        const team = await this.pokemon.team(oauthId);
        if (!team || team.length === 0) {
            return { ok: false, reply: "you don't have any pokemon. You can birth one using channel points" };
        }
        if (kind === 'single') {
            const starter = inSlot(team, 1);
            if (!starter) {
                return {
                    ok: false,
                    reply: "you don't have a pokemon assigned to slot 1. Swap another pokemon into slot 1 or birth one using channel points",
                };
            }
            if (isAwayInPmd(starter)) return { ok: false, reply: new PokemonAwayError(starter, 'battle').message };
            return { ok: true, pokemon: [starter] };
        }
        const ready = battleReady(team);
        if (ready.length === 0) return { ok: false, reply: 'all of your pokemon are away in PMD' };
        return { ok: true, pokemon: ready };
    }

    /** Ends whatever the lobby held. A fresh object, so late callbacks holding the old one can tell. */
    private clear(kind: BattleKind): void {
        const lobby = this.lobbies[kind];
        if (lobby.timer) clearTimeout(lobby.timer);
        this.lobbies[kind] = { challenger: null, accepting: false, timer: null };
    }

    onModuleDestroy(): void {
        this.clear('single');
        this.clear('team');
    }
}

function toBattlePokemon(pokemon: Pokemon): BattlePokemon {
    return {
        name: pokemon.name,
        gender: pokemon.gender,
        moves: pokemon.moves,
        ability: pokemon.ability,
        item: pokemon.item,
        level: pokemon.level,
        shiny: pokemon.shiny,
        nature: pokemon.nature,
    };
}
