import type { EntityManager } from '@mikro-orm/postgresql';
import { Pokemon } from '../src/entities';
import type { ActiveGame } from '../src/entities';
import type { TwitchTokenStoreService } from '../src/modules/auth/twitch-token-store.service';
import { CommandRegistryService } from '../src/modules/commands/command-registry.service';
import type { StatChange } from '../src/modules/pokemon/battle/battle-resolution';
import { assertInBrobot, isAwayInPmd } from '../src/modules/pokemon/exclusivity';
import type { NewPokemon } from '../src/modules/pokemon/pokemon-factory';
import type { BattleKind, PokemonWriteService, Trainer } from '../src/modules/pokemon/pokemon-write.service';
import { Random } from '../src/modules/pokemon/random';
import { inSlot, planCreateInSlot, planDelete, planSwap, slotForCatch, TeamRuleError } from '../src/modules/pokemon/team-rules';
import { BotChatService } from '../src/modules/twitch/chat/bot-chat.service';
import type { ChatUser } from '../src/modules/twitch/chat/chat-types';
import { testEnvService } from './helpers';

/**
 * The real chat service, never connected: `receive()` feeds it lines, and
 * everything it would say lands in `said`.
 */
export function fakeChat(overrides: Record<string, string> = {}): { chat: BotChatService; said: string[] } {
    const chat = new BotChatService(testEnvService(overrides), {} as TwitchTokenStoreService);
    const said: string[] = [];
    vi.spyOn(chat, 'say').mockImplementation(async text => {
        said.push(text.replace(/\s+/g, ' ').trim());
    });
    return { chat, said };
}

export function viewer(login: string, extra: Partial<ChatUser> = {}): ChatUser {
    return { id: `id-${login}`, login, displayName: login, isBroadcaster: false, isMod: false, ...extra };
}

/** A registry on catalog defaults whose switches are not persisted anywhere. */
export function memoryRegistry(): CommandRegistryService {
    const store = {
        fork: () => store,
        find: async () => [],
        findOne: async () => null,
        create: (_entity: unknown, data: object) => data,
        flush: async () => undefined,
    };
    return new CommandRegistryService(store as unknown as EntityManager);
}

/** Rolls taken from a script, in order; `int` answers with the next number. */
export class ScriptedRandom extends Random {
    constructor(private readonly rolls: number[] = []) {
        super();
    }

    override int(min: number, max: number): number {
        const next = this.rolls.shift();
        return next === undefined ? min : Math.min(max, Math.max(min, next));
    }
}

let nextId = 1;

export function storedPokemon(
    ownerId: string,
    slot: number,
    name: string,
    extra: Partial<Pick<Pokemon, 'level' | 'shiny' | 'active_game' | 'wins' | 'losses' | 'draws'>> & {
        active_game?: ActiveGame;
    } = {},
): Pokemon {
    return Object.assign(new Pokemon(), {
        id: `pk-${nextId++}`,
        name,
        name_id: name.toLowerCase(),
        slot,
        level: 5,
        shiny: false,
        gender: 'M',
        moves: ['tackle'],
        color: 'Yellow',
        dex_num: 25,
        types: ['Electric'],
        nature: 'Adamant',
        ability: 'Static',
        item: '',
        wins: 0,
        losses: 0,
        draws: 0,
        active_game: 'brobot' as ActiveGame,
        twitch_user: { oauth_id: ownerId },
        ...extra,
    });
}

/**
 * {@link PokemonWriteService} over an in-memory table, applying the same
 * team rules and exclusivity checks (the real service is a thin transaction
 * around them).
 */
export class MemoryPokemonStore implements Pick<
    PokemonWriteService,
    'team' | 'starter' | 'addCaught' | 'createInSlot' | 'swap' | 'delete' | 'levelUpStarter' | 'applyBattle' | 'saveOutcome'
> {
    readonly teams = new Map<string, Pokemon[]>();
    readonly outcomes: Record<BattleKind, string[] | null> = { single: null, team: null };

    give(ownerId: string, ...pokemon: Pokemon[]): void {
        this.teams.set(ownerId, [...(this.teams.get(ownerId) ?? []), ...pokemon]);
    }

    async team(oauthId: string): Promise<Pokemon[] | null> {
        const team = this.teams.get(oauthId);
        return team ? [...team].sort((a, b) => a.slot - b.slot) : null;
    }

    async starter(oauthId: string): Promise<Pokemon | null> {
        return inSlot(this.teams.get(oauthId) ?? [], 1) ?? null;
    }

    async addCaught(trainer: Trainer, fresh: NewPokemon): Promise<Pokemon> {
        const team = this.teams.get(trainer.oauthId) ?? [];
        const created = storedPokemon(trainer.oauthId, slotForCatch(team), fresh.name, { level: fresh.level, shiny: fresh.shiny });
        this.teams.set(trainer.oauthId, [...team, created]);
        return created;
    }

    async createInSlot(trainer: Trainer, fresh: NewPokemon, slot: number): Promise<Pokemon> {
        const team = this.teams.get(trainer.oauthId) ?? [];
        const replaced = planCreateInSlot(team, slot);
        const created = storedPokemon(trainer.oauthId, slot, fresh.name, { level: fresh.level, shiny: fresh.shiny });
        this.teams.set(trainer.oauthId, [...team.filter(pokemon => pokemon !== replaced), created]);
        return created;
    }

    async swap(oauthId: string, a: number, b: number): Promise<void> {
        const team = this.teams.get(oauthId);
        if (!team) throw new TeamRuleError('No team found');
        const [first, second] = planSwap(team, a, b);
        first.slot = b;
        second.slot = a;
    }

    async delete(oauthId: string, slot: number): Promise<Pokemon | null> {
        const team = this.teams.get(oauthId);
        if (!team) return null;
        const doomed = planDelete(team, slot);
        if (doomed) this.teams.set(oauthId, team.filter(pokemon => pokemon !== doomed));
        return doomed;
    }

    async levelUpStarter(oauthId: string): Promise<Pokemon> {
        const starter = await this.starter(oauthId);
        if (!starter) throw new TeamRuleError('you have no starter pokemon in slot 1');
        assertInBrobot(starter, 'level-up');
        starter.level += 1;
        return starter;
    }

    async applyBattle(changes: readonly StatChange[]): Promise<void> {
        const all = [...this.teams.values()].flat();
        for (const change of changes) {
            const row = all.find(pokemon => pokemon.id === change.id);
            if (!row || isAwayInPmd(row)) continue;
            row.wins += change.wins;
            row.losses += change.losses;
            row.draws += change.draws;
            row.level += change.levels;
        }
    }

    async saveOutcome(kind: BattleKind, log: string[]): Promise<void> {
        this.outcomes[kind] = log;
    }
}
