import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { EnvService } from '../../../config/env.service';
import { POKE_FAILED_CATCHES } from '../../pokemon/poke-info';
import { PokemonFactory } from '../../pokemon/pokemon-factory';
import type { NewPokemon } from '../../pokemon/pokemon-factory';
import { PokemonWriteService } from '../../pokemon/pokemon-write.service';
import { Random } from '../../pokemon/random';
import { TeamRuleError } from '../../pokemon/team-rules';
import { BotChatService } from '../chat/bot-chat.service';
import type { ChatUser } from '../chat/chat-types';

/** A wild Pokémon appears this often… */
export const DROP_EVERY_MS = 30 * 60 * 1000;
/** …and stays this long. */
export const DROP_LASTS_MS = 2 * 60 * 1000;
/** Failed throws allowed per viewer per drop. */
export const MAX_CATCH_ATTEMPTS = 3;

interface ActiveDrop {
    pokemon: NewPokemon;
    /** Viewers who caught it (by Twitch id); each may catch once. */
    caughtBy: Set<string>;
    attempts: Map<string, number>;
    timer: NodeJS.Timeout;
}

/**
 * The random chat drops: every 30 minutes a wild level-1 Pokémon from the
 * drop dex appears for 2 minutes, and anyone may `!pokemon catch` it — a
 * coin flip per throw, three throws each, one catch each, into their lowest
 * free slot.
 */
@Injectable()
export class PokemonDropsService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(PokemonDropsService.name);
    private drop: ActiveDrop | null = null;
    private schedule: NodeJS.Timeout | null = null;

    constructor(
        private readonly env: EnvService,
        private readonly chat: BotChatService,
        private readonly factory: PokemonFactory,
        private readonly pokemon: PokemonWriteService,
        private readonly random: Random,
    ) {}

    onApplicationBootstrap(): void {
        if (!this.env.get('TWITCH_BOT_ENABLED')) return;
        this.schedule = setInterval(() => {
            // Nobody would see a drop while chat is down.
            if (!this.chat.isConnected) return;
            this.startDrop().catch((error: unknown) => {
                this.logger.error('Could not start a drop', error instanceof Error ? error.stack : error);
            });
        }, DROP_EVERY_MS);
        this.schedule.unref();
    }

    get active(): NewPokemon | null {
        return this.drop?.pokemon ?? null;
    }

    async startDrop(pokemon?: NewPokemon): Promise<void> {
        this.endDrop(false);
        const wild = pokemon ?? (await this.factory.randomDrop());
        const timer = setTimeout(() => this.endDrop(true), DROP_LASTS_MS);
        timer.unref();
        this.drop = { pokemon: wild, caughtBy: new Set(), attempts: new Map(), timer };
        this.logger.log(`Drop: ${wild.shiny ? 'shiny ' : ''}${wild.name}`);
        await this.chat.say(
            `/me A wild level 1 ${wild.shiny ? 'PogChamp ****SHINY**** PogChamp' : ''} ${wild.name} has appeared for 2 minutes! Type "!pokemon catch" for a chance to add it to your team`,
        );
    }

    /** `!pokemon catch`. */
    async catch(user: ChatUser): Promise<void> {
        const drop = this.drop;
        if (!drop) {
            await this.chat.say('No pokemon to catch. A pokemon will drop every 30 minutes.');
            return;
        }
        if (drop.caughtBy.has(user.id)) return;

        const attempts = drop.attempts.get(user.id) ?? 0;
        if (attempts >= MAX_CATCH_ATTEMPTS) {
            await this.chat.say(`@${user.login} you somehow failed 3 times. Try again on the next encounter`);
            return;
        }
        if (this.random.int(1, 2) <= 1) {
            drop.attempts.set(user.id, attempts + 1);
            const outOfAttempts = attempts + 1 === MAX_CATCH_ATTEMPTS;
            await this.chat.say(
                `@${user.login}, ${drop.pokemon.name} ${this.random.pick(POKE_FAILED_CATCHES)}. ${
                    outOfAttempts ? 'You are out of attempts' : 'Try again...'
                }`,
            );
            return;
        }

        // Counted before the write, so a second `!pokemon catch` sent while it
        // runs is ignored rather than catching a second copy.
        drop.caughtBy.add(user.id);
        try {
            await this.pokemon.addCaught({ oauthId: user.id, displayName: user.displayName }, drop.pokemon);
            await this.chat.say(`@${user.login}, success!`);
        } catch (error) {
            drop.caughtBy.delete(user.id);
            if (error instanceof TeamRuleError) {
                await this.chat.say(`@${user.login}, ${error.message}`);
                return;
            }
            this.logger.error(`Catch failed for ${user.login}`, error instanceof Error ? error.stack : error);
        }
    }

    private endDrop(announce: boolean): void {
        const drop = this.drop;
        if (!drop) return;
        clearTimeout(drop.timer);
        this.drop = null;
        if (!announce) return;
        const caught = drop.caughtBy.size;
        void this.chat.say(`Ending encounter. ${caught} ${caught === 1 ? 'person' : 'people'} caught ${drop.pokemon.name}`);
    }

    onModuleDestroy(): void {
        if (this.schedule) clearInterval(this.schedule);
        if (this.drop) clearTimeout(this.drop.timer);
        this.drop = null;
    }
}
