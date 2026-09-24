import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
 * State is held in memory and resets to each command's default when the
 * process restarts — the same lifetime the old `disableQuack()` toggle had.
 * B2's chat handlers call {@link isEnabled} before running a command; the
 * admin site flips it through `POST /api/commands`.
 */
@Injectable()
export class CommandRegistryService {
    private readonly logger = new Logger(CommandRegistryService.name);
    private readonly definitions = new Map<string, CommandDefinition>(
        COMMAND_CATALOG.map(definition => [definition.name, definition]),
    );
    private readonly enabled = new Map<string, boolean>(
        COMMAND_CATALOG.map(definition => [definition.name, definition.enabledByDefault]),
    );

    list(): CommandState[] {
        return [...this.definitions.values()].map(definition => this.toState(definition));
    }

    /** Unknown names are treated as disabled, so a typo in B2 fails closed. */
    isEnabled(name: string): boolean {
        return this.enabled.get(name) ?? false;
    }

    setEnabled(name: string, enabled: boolean, actor: string): CommandState {
        const definition = this.definitions.get(name);
        if (!definition) {
            throw new NotFoundException(`Unknown command "${name}"`);
        }
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
