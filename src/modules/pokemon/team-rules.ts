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

/**
 * The Pokémon that hold a slot. An away Pokémon holds none (owner,
 * 2026-10-29), so the rules below can never address one by slot; their away
 * guards stay as defence in depth.
 */
export function slotted<T extends HeldPokemon>(team: readonly T[]): (T & { slot: number })[] {
    return team.filter((pokemon): pokemon is T & { slot: number } => pokemon.slot !== null);
}

export function inSlot<T extends HeldPokemon>(team: readonly T[], slot: number): T | undefined {
    return slotted(team).find(pokemon => pokemon.slot === slot);
}

/** The lowest slot no Pokémon holds (so 1 whenever the starter slot is free), or null when all six are taken. */
export function lowestFreeSlot(team: readonly Pick<HeldPokemon, 'slot'>[]): number | null {
    const taken = new Set(team.map(pokemon => pokemon.slot));
    for (let slot = 1; slot <= TEAM_SIZE; slot++) {
        if (!taken.has(slot)) return slot;
    }
    return null;
}

/** Slotted Pokémon by slot, then the unslotted (away) ones: the order a team is shown in. */
export function bySlot(a: Pick<HeldPokemon, 'slot'>, b: Pick<HeldPokemon, 'slot'>): number {
    return (a.slot ?? TEAM_SIZE + 1) - (b.slot ?? TEAM_SIZE + 1);
}

/**
 * Where a caught Pokémon goes: slot 1 while there is no starter, otherwise
 * the lowest free slot. A Pokémon away in PMD holds no slot, so its old one
 * is free.
 */
export function slotForCatch(team: readonly HeldPokemon[]): number {
    const slot = lowestFreeSlot(team);
    if (slot === null) {
        throw new TeamRuleError("can't catch pokemon because no slots available. You need to delete one first.");
    }
    return slot;
}

/**
 * `!pokemon swap a b`: the Pokémon in slot `a` and in slot `b` trade places,
 * neither of which may be away in PMD. One of the two slots may be empty, and
 * the other Pokémon then moves into it: that is how a viewer whose starter
 * left for PMD puts another Pokémon into slot 1. Returns what is in `a` and
 * `b`, at least one of them a Pokémon.
 */
export function planSwap<T extends HeldPokemon>(team: readonly T[], a: number, b: number): [T | null, T | null] {
    if (a === b) throw new TeamRuleError(`Can't swap to same slot`);
    if (slotted(team).length === 0) throw new TeamRuleError('No pokemon to swap');
    const first = inSlot(team, a) ?? null;
    const second = inSlot(team, b) ?? null;
    if (!first && !second) throw new TeamRuleError('One of your slots has no pokemon');
    if (first) assertInBrobot(first, 'swap');
    if (second) assertInBrobot(second, 'swap');
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
