/**
 * A `!command` typed in chat. `trigger` is the word after `!`, lower-cased;
 * `args` are the remaining words as typed (case preserved: `!pokemon create`
 * takes a species name).
 */
export interface ParsedCommand {
    trigger: string;
    args: string[];
}

/**
 * Parses a chat line the way the old bot did — trimmed, must start with `!`,
 * split on spaces — except that runs of whitespace no longer produce empty
 * arguments (`!pokemon  swap 1 2` used to read the slot as `""`).
 * Returns null for anything that is not a command.
 */
export function parseChatCommand(text: string): ParsedCommand | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('!')) return null;
    const [first = '', ...args] = trimmed.slice(1).split(/\s+/);
    const trigger = first.toLowerCase();
    if (!trigger) return null;
    return { trigger, args };
}

/** `!pokemon <sub>` → catalog name. Aliases resolve to their command. */
const POKEMON_SUBCOMMANDS = new Map([
    ['battle', 'pokemon-battle'],
    ['teambattle', 'pokemon-teambattle'],
    ['team', 'pokemon-team'],
    ['catch', 'pokemon-catch'],
    ['delete', 'pokemon-delete'],
    ['remove', 'pokemon-delete'],
    ['swap', 'pokemon-swap'],
    ['switch', 'pokemon-swap'],
]);

const TOP_LEVEL = new Map([
    ['chatban', 'chatban'],
    ['voiceban', 'voiceban'],
    ['dice', 'dice'],
    ['rps', 'rps'],
    ['chess', 'chess'],
    ['ping', 'ping'],
    ['commands', 'commands'],
    ['command', 'commands'],
]);

/**
 * The catalog entry (`command-catalog.ts`) whose switch governs this command,
 * or null for commands that are always on: bare `!pokemon` (the help link),
 * `!pokemon create` (admin-only, not listed) and anything brobot does not
 * know.
 */
export function catalogNameFor(command: ParsedCommand): string | null {
    if (command.trigger === 'pokemon') {
        const sub = command.args.at(0)?.toLowerCase();
        return sub ? (POKEMON_SUBCOMMANDS.get(sub) ?? null) : null;
    }
    // The old bot quacked for any trigger containing "quack" (`!quackquack`).
    if (command.trigger.includes('quack')) return 'quack';
    return TOP_LEVEL.get(command.trigger) ?? null;
}
