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
    slot: number;
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
        super(`your ${pokemon.name} in slot ${pokemon.slot} is away in PMD and can't ${WHAT_IT_CANNOT_DO[action]}`);
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

/**
 * One slot as `!pokemon team` shows it: `1. Lv 12 Pikachu`, or
 * `2. Lv 40 Eevee (away in PMD)`.
 */
export function describeSlot(pokemon: HeldPokemon & { level: number; shiny: boolean }): string {
    const shiny = pokemon.shiny ? 'shiny ' : '';
    const away = isAwayInPmd(pokemon) ? ' (away in PMD)' : '';
    return `${pokemon.slot}. Lv ${pokemon.level} ${shiny}${pokemon.name}${away}`;
}
