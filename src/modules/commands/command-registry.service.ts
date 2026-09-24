import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { CommandSetting } from '../../entities';
import { COMMAND_CATALOG } from './command-catalog';
import type { CommandCategory, CommandDefinition } from './command-catalog';

export interface CommandState {
    name: string;
    trigger: string;
    aliases: string[];
    category: CommandCategory;
    description: string;
    enabled: boolean;
}

/**
 * Which chat commands are currently switched on.
 *
 * A switch flipped from the admin site (`POST /api/commands`) or by a
 * channel-point redeem is written to `command_setting` and survives a
 * restart; a command nobody has flipped runs on its catalog default. The bot
 * asks {@link isEnabled} on every chat message, so reads come from memory,
 * loaded once at boot.
 */
@Injectable()
export class CommandRegistryService implements OnApplicationBootstrap {
    private readonly logger = new Logger(CommandRegistryService.name);
    private readonly definitions = new Map<string, CommandDefinition>(
        COMMAND_CATALOG.map(definition => [definition.name, definition]),
    );
    private readonly enabled = new Map<string, boolean>(
        COMMAND_CATALOG.map(definition => [definition.name, definition.enabledByDefault]),
    );

    constructor(private readonly em: EntityManager) {}

    async onApplicationBootstrap(): Promise<void> {
        await this.load();
    }

    /**
     * Applies the stored switches over the defaults. A database that cannot be
     * read leaves the defaults in place rather than stopping the API: the
     * switches are a convenience, and the health endpoint reports the database.
     */
    async load(): Promise<void> {
        let rows: CommandSetting[];
        try {
            rows = await this.em.fork().find(CommandSetting, {});
        } catch (error) {
            this.logger.warn(
                `Could not read command switches, running on catalog defaults: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
        }
        for (const row of rows) {
            if (this.definitions.has(row.name)) this.enabled.set(row.name, row.enabled);
        }
    }

    list(): CommandState[] {
        return [...this.definitions.values()].map(definition => this.toState(definition));
    }

    /** Unknown names are treated as disabled, so a typo in the bot fails closed. */
    isEnabled(name: string): boolean {
        return this.enabled.get(name) ?? false;
    }

    /** Persists first, so a failed write leaves the switch where it was. */
    async setEnabled(name: string, enabled: boolean, actor: string): Promise<CommandState> {
        const definition = this.definitions.get(name);
        if (!definition) {
            throw new NotFoundException(`Unknown command "${name}"`);
        }
        const em = this.em.fork();
        const existing = await em.findOne(CommandSetting, { name });
        if (existing) {
            existing.enabled = enabled;
            existing.updated_by = actor;
        } else {
            em.create(CommandSetting, { name, enabled, updated_by: actor });
        }
        await em.flush();

        this.enabled.set(name, enabled);
        this.logger.log(`${actor} ${enabled ? 'enabled' : 'disabled'} command ${name}`);
        return this.toState(definition);
    }

    private toState(definition: CommandDefinition): CommandState {
        return {
            name: definition.name,
            trigger: definition.trigger,
            aliases: [...definition.aliases],
            category: definition.category,
            description: definition.description,
            enabled: this.isEnabled(definition.name),
        };
    }
}
