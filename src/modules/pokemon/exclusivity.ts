import type { ActiveGame } from '../../entities';

/**
 * The brobot half of the "one game at a time" rule (migration plan §4): a
 * Pokémon whose `active_game` is `pmd` is away in pmd-online, and brobot
 * treats its row as read-only until it is sent back.
 *
 * §4 names four things it cannot do: be battled, swapped, deleted or
 * slotted (have another Pokémon put into its slot). Levelling it up and
 * roaring it on stream write to or show a Pokémon that is not here, so they
 * are refused the same way.
 */
export type GuardedAction = 'battle' | 'swap' | 'delete' | 'slot' | 'level-up' | 'roar';

/** The columns the rule reads. `Pokemon` rows satisfy it. */
export interface HeldPokemon {
    name: string;
    /** Null while away in PMD: an away Pokémon holds no slot. */
    slot: number | null;
    active_game: ActiveGame;
}

const WHAT_IT_CANNOT_DO: Record<GuardedAction, string> = {
    battle: 'battle',
    swap: 'be swapped',
    delete: 'be deleted',
    slot: 'be replaced',
    'level-up': 'level up',
    roar: 'roar',
};

export function isAwayInPmd(pokemon: Pick<HeldPokemon, 'active_game'>): boolean {
    return pokemon.active_game === 'pmd';
}

/** Refusal of an action on a Pokémon that is away. The message is chat copy. */
export class PokemonAwayError extends Error {
    constructor(
        readonly pokemon: HeldPokemon,
        readonly action: GuardedAction,
    ) {
        const where = pokemon.slot === null ? '' : ` in slot ${pokemon.slot}`;
        super(`your ${pokemon.name}${where} is away in PMD and can't ${WHAT_IT_CANNOT_DO[action]}`);
        this.name = 'PokemonAwayError';
    }
}

/** Throws {@link PokemonAwayError} when `pokemon` is away in PMD. */
export function assertInBrobot(pokemon: HeldPokemon, action: GuardedAction): void {
    if (isAwayInPmd(pokemon)) throw new PokemonAwayError(pokemon, action);
}

/** The Pokémon of a team that can take part in a battle right now. */
export function battleReady<T extends HeldPokemon>(team: readonly T[]): T[] {
    return team.filter(pokemon => !isAwayInPmd(pokemon));
}

type ShownPokemon = HeldPokemon & { level: number; shiny: boolean };

/**
 * One Pokémon as `!pokemon team` shows it: `1. Lv 12 Pikachu`, or
 * `away in PMD: Lv 81 Groudon` for one that is away (it holds no slot, so no
 * number).
 */
export function describeSlot(pokemon: ShownPokemon): string {
    const shown = `Lv ${pokemon.level} ${pokemon.shiny ? 'shiny ' : ''}${pokemon.name}`;
    const away = isAwayInPmd(pokemon);
    if (pokemon.slot === null) return away ? `away in PMD: ${shown}` : shown;
    // A slotted Pokémon is never away; this only shows a row that predates the rule.
    return `${pokemon.slot}. ${shown}${away ? ' (away in PMD)' : ''}`;
}

/** `!pokemon team`: the slotted team by slot, then the Pokémon away in PMD. */
export function describeTeam(team: readonly ShownPokemon[]): string[] {
    const rank = (pokemon: ShownPokemon) => pokemon.slot ?? Number.MAX_SAFE_INTEGER;
    return [...team].sort((a, b) => rank(a) - rank(b)).map(describeSlot);
}
