import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { TwitchUser } from '../../../entities';
import { TwitchOAuthClient } from '../../auth/twitch-oauth.client';
import { catalogNameFor } from '../../commands/command-parser';
import { CommandRegistryService } from '../../commands/command-registry.service';
import { describeSlot, PokemonAwayError } from '../../pokemon/exclusivity';
import { POKE_SLAUGHTER_ACTIONS, POKE_SLAUGHTER_APPROACHES } from '../../pokemon/poke-info';
import { PokemonFactory, UnknownSpeciesError } from '../../pokemon/pokemon-factory';
import { PokemonWriteService } from '../../pokemon/pokemon-write.service';
import { Random } from '../../pokemon/random';
import { inSlot, parseSlot, TeamRuleError } from '../../pokemon/team-rules';
import { BotChatService } from '../chat/bot-chat.service';
import type { ChatCommand, ChatUser } from '../chat/chat-types';
import { UiLinks } from '../ui-links';
import { DailyLimit } from './daily-limit';
import { PokemonBattlesService } from './pokemon-battles.service';
import { PokemonDropsService } from './pokemon-drops.service';

/** Deletions allowed per viewer per day (resets at midnight New York time). */
export const DAILY_DELETE_LIMIT = 6;

const CREATE_USAGE = 'Usage: !pokemon create <user> <pokemon> <level> <shiny 0|1>';

/**
 * The `!pokemon` family in chat. Each subcommand obeys its switch in the
 * command registry; a switched-off one is ignored, as are unknown words
 * (which get the help link, as before).
 */
@Injectable()
export class PokemonCommandsService implements OnModuleDestroy {
    private readonly logger = new Logger(PokemonCommandsService.name);
    private readonly subscription: Subscription;
    private readonly deletions = new DailyLimit(DAILY_DELETE_LIMIT);

    constructor(
        private readonly chat: BotChatService,
        private readonly registry: CommandRegistryService,
        private readonly pokemon: PokemonWriteService,
        private readonly factory: PokemonFactory,
        private readonly battles: PokemonBattlesService,
        private readonly drops: PokemonDropsService,
        private readonly random: Random,
        private readonly links: UiLinks,
        private readonly twitch: TwitchOAuthClient,
        private readonly em: EntityManager,
    ) {
        this.subscription = chat.commands$.subscribe(command => {
            if (command.command.trigger !== 'pokemon') return;
            this.handle(command).catch((error: unknown) => {
                this.logger.error(`"${command.text}" failed`, error instanceof Error ? error.stack : error);
            });
        });
    }

    async handle(command: ChatCommand): Promise<void> {
        const { user } = command;
        const args = command.command.args;
        const name = catalogNameFor(command.command);
        if (name && !this.registry.isEnabled(name)) return;

        switch (args.at(0)?.toLowerCase()) {
            case 'team':
                return this.team(user);
            case 'battle':
                return this.battles.command('single', user);
            case 'teambattle':
                return this.battles.command('team', user);
            case 'catch':
                return this.drops.catch(user);
            case 'delete':
            case 'remove':
                return this.delete(user, args[1]);
            case 'swap':
            case 'switch':
                return this.swap(user, args[1], args[2]);
            case 'create':
                return this.create(user, args.slice(1));
            default:
                return this.chat.say(`Pokemon Commands: ${this.links.commands()}`);
        }
    }

    /** A link to the team page, and the team itself — a Pokémon away in PMD shows as such. */
    private async team(user: ChatUser): Promise<void> {
        const team = await this.pokemon.team(user.id);
        if (!team) return this.chat.say('You have no pokemon team');
        if (team.length === 0) return this.chat.say('You have no pokemon in your team');
        await this.chat.say(
            `Check out your team here: ${this.links.team(user.login)} · ${team.map(describeSlot).join(' · ')}`,
        );
    }

    private async delete(user: ChatUser, rawSlot: string | undefined): Promise<void> {
        const slot = parseSlot(rawSlot);
        if (slot === null) return this.chat.say(`@${user.login}, please enter a slot number between 1 and 6`);
        try {
            const target = inSlot((await this.pokemon.team(user.id)) ?? [], slot);
            if (!target) return await this.chat.say(`You have no pokemon in slot ${slot}`);
            if (this.deletions.isExhausted(user.id)) {
                return await this.chat.say(`@${user.login}, you've exceeded your limit for the day. Try again after 12AM EST`);
            }
            const deleted = await this.pokemon.delete(user.id, slot);
            if (!deleted) return await this.chat.say(`You have no pokemon in slot ${slot}`);
            this.deletions.record(user.id);
            await this.chat.say(
                `@${user.login} ${this.random.pick(POKE_SLAUGHTER_APPROACHES)} ${deleted.name} ${this.random.pick(POKE_SLAUGHTER_ACTIONS)}`,
            );
        } catch (error) {
            if (error instanceof PokemonAwayError) return this.chat.say(`@${user.login}, ${error.message}`);
            this.logger.error(`Delete failed for ${user.login}`, error instanceof Error ? error.stack : error);
            await this.chat.say('Something went horribly wrong deleting a pokemon. Complain to someone');
        }
    }

    private async swap(user: ChatUser, rawA: string | undefined, rawB: string | undefined): Promise<void> {
        const a = parseSlot(rawA);
        const b = parseSlot(rawB);
        if (a === null || b === null) {
            return this.chat.say(`@${user.login}, make sure both slot numbers are between 1 and 6`);
        }
        try {
            await this.pokemon.swap(user.id, a, b);
            await this.chat.say(`@${user.login}, swap successful`);
        } catch (error) {
            if (error instanceof PokemonAwayError) return this.chat.say(`@${user.login}, ${error.message}`);
            if (error instanceof TeamRuleError) return this.chat.say(error.message);
            this.logger.error(`Swap failed for ${user.login}`, error instanceof Error ? error.stack : error);
            await this.chat.say("Swapping pokemon failed. That's not a good sign");
        }
    }

    /**
     * `!pokemon create <user> <pokemon> <level> <shiny 0|1>` — fixes a
     * viewer's team by hand. The old bot allowed two hard-coded logins; it is
     * now the broadcaster, or anyone brobot has given the `Admin` role.
     */
    private async create(admin: ChatUser, args: string[]): Promise<void> {
        if (!(await this.isAdmin(admin))) return;
        const [login, species, rawLevel, rawShiny] = [args.at(0), args.at(1), args.at(2), args.at(3)];
        const level = Number.parseInt(rawLevel ?? '', 10);
        if (!login || !species || !Number.isInteger(level) || level < 1) return this.chat.say(CREATE_USAGE);
        const target = login.toLowerCase();

        let account;
        try {
            account = await this.twitch.getUserByLogin(target);
        } catch (error) {
            this.logger.error(`Twitch lookup failed for ${target}`, error instanceof Error ? error.message : error);
            return this.chat.say(`Could not find Twitch account for user: ${target}`);
        }
        if (!account) return this.chat.say(`No User or OauthID found for: ${target}`);

        try {
            const fresh = await this.factory.specific(species, level, rawShiny === '1');
            await this.pokemon.addCaught({ oauthId: account.id, displayName: account.display_name }, fresh);
            await this.chat.say(`Done! See changes: ${this.links.team(target)}`);
        } catch (error) {
            if (error instanceof UnknownSpeciesError) return this.chat.say(error.message);
            if (error instanceof TeamRuleError) return this.chat.say(`@${admin.login}: ${error.message}`);
            this.logger.error(`Create failed for ${target}`, error instanceof Error ? error.stack : error);
        }
    }

    private async isAdmin(user: ChatUser): Promise<boolean> {
        if (user.isBroadcaster) return true;
        const row = await this.em.fork().findOne(TwitchUser, { oauth_id: user.id }, { fields: ['roles'] });
        return row?.roles.includes('Admin') ?? false;
    }

    onModuleDestroy(): void {
        this.subscription.unsubscribe();
    }
}
