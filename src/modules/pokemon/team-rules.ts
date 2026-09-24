import { assertInBrobot } from './exclusivity';
import type { HeldPokemon } from './exclusivity';

export const TEAM_SIZE = 6;

/**
 * A team change the rules refuse. The message is the chat copy the old bot
 * used (its `PokemonSwapException` / `PokemonCatchException` /
 * `PokemonRedeemException` texts).
 */
export class TeamRuleError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TeamRuleError';
    }
}

export function isValidSlot(slot: number): boolean {
    return Number.isInteger(slot) && slot >= 1 && slot <= TEAM_SIZE;
}

/**
 * A slot number from chat (`!pokemon delete 3`, a `Pokemon Create` redeem's
 * input). `parseInt` semantics, as before: `"3rd"` is 3. Null when it is not
 * 1–6.
 */
export function parseSlot(raw: string | undefined): number | null {
    if (raw === undefined) return null;
    const slot = Number.parseInt(raw, 10);
    return isValidSlot(slot) ? slot : null;
}

export function inSlot<T extends HeldPokemon>(team: readonly T[], slot: number): T | undefined {
    return team.find(pokemon => pokemon.slot === slot);
}

/**
 * Where a caught Pokémon goes: slot 1 while there is no starter, otherwise
 * the lowest free slot. A Pokémon away in PMD still holds its slot.
 */
export function slotForCatch(team: readonly HeldPokemon[]): number {
    if (!inSlot(team, 1)) return 1;
    for (let slot = 1; slot <= TEAM_SIZE; slot++) {
        if (!inSlot(team, slot)) return slot;
    }
    throw new TeamRuleError("can't catch pokemon because no slots available. You need to delete one first.");
}

/**
 * `!pokemon swap a b`: both slots must hold a Pokémon, neither of which is
 * away in PMD. Returns the two Pokémon to exchange slots.
 */
export function planSwap<T extends HeldPokemon>(team: readonly T[], a: number, b: number): [T, T] {
    if (a === b) throw new TeamRuleError(`Can't swap to same slot`);
    if (team.length === 0) throw new TeamRuleError('No pokemon to swap');
    const first = inSlot(team, a);
    const second = inSlot(team, b);
    if (!first || !second) throw new TeamRuleError('One of your slots has no pokemon');
    assertInBrobot(first, 'swap');
    assertInBrobot(second, 'swap');
    return [first, second];
}

/** `!pokemon delete n`: the Pokémon to delete, or null when the slot is empty. */
export function planDelete<T extends HeldPokemon>(team: readonly T[], slot: number): T | null {
    const pokemon = inSlot(team, slot) ?? null;
    if (pokemon) assertInBrobot(pokemon, 'delete');
    return pokemon;
}

/**
 * A `Pokemon Create` redeem into `slot`: the starter comes first, and a
 * Pokémon already in the slot is replaced — unless it is away in PMD.
 * Returns the Pokémon being replaced, if any.
 */
export function planCreateInSlot<T extends HeldPokemon>(team: readonly T[], slot: number): T | null {
    if (!isValidSlot(slot)) throw new TeamRuleError('Slot number must be between 1 & 6');
    if (slot !== 1 && !inSlot(team, 1)) {
        throw new TeamRuleError('You must create a starter pokemon in slot 1 first');
    }
    const replaced = inSlot(team, slot) ?? null;
    if (replaced) assertInBrobot(replaced, 'slot');
    return replaced;
}
