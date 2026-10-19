import { Dex } from '@pkmn/sim';
import type { Species } from '@pkmn/sim';
import type { Pokemon } from '../../entities/pokemon.entity';

/**
 * What a Pokémon may bring home besides its level (owner requirement 5:
 * changes made while away are the truth when it comes back): an evolution,
 * and a new moveset. Checked against `@pkmn`, nothing else; pure, so the
 * rules are unit-tested directly.
 *
 * The generation-4 dex is the one `PokemonFactory` creates rows from, so an
 * evolved row's `types` and `color` read as a freshly caught one would.
 * Species from later generations (Sylveon, Kingambit) are in it too, marked
 * `Future`, which the gen-4 custom battle accepts.
 */
const gen4 = Dex.forGen(4);

/** The species columns an evolution rewrites. */
export type SpeciesColumns = Pick<Pokemon, 'name' | 'name_id' | 'dex_num' | 'types' | 'color'>;

export type EvolutionCheck =
    | { kind: 'evolve'; columns: SpeciesColumns }
    /** The species sent is the row's own: nothing to change. */
    | { kind: 'same' }
    | { kind: 'refuse'; message: string };

/** No real species is more than two evolutions from its base; the bound only stops a broken chain looping. */
const MAX_PREVO_STEPS = 8;

function columnsOf(species: Species): SpeciesColumns {
    return {
        name: species.name,
        name_id: species.id,
        dex_num: species.num,
        types: [...species.types],
        color: species.color,
    };
}

/**
 * Whether `targetNameId` is a forward evolution of `currentNameId`: the
 * current species appears somewhere up the target's `prevo` chain. Only the
 * id is trusted; the name, dex number, types and colour are recomputed from
 * `@pkmn`, whatever the caller sent alongside it.
 */
export function evolutionOnReturn(currentNameId: string, targetNameId: string): EvolutionCheck {
    const current = gen4.species.get(currentNameId);
    const target = gen4.species.get(targetNameId);
    if (!target.exists || target.num < 1) {
        return { kind: 'refuse', message: `${targetNameId} is not a Pokémon species` };
    }
    if (current.exists && current.id === target.id) return { kind: 'same' };

    let step: Species = target;
    for (let i = 0; i < MAX_PREVO_STEPS && step.prevo; i++) {
        step = gen4.species.get(step.prevo);
        if (!step.exists) break;
        if (current.exists && step.id === current.id) {
            return { kind: 'evolve', columns: columnsOf(target) };
        }
    }
    const from = current.exists ? current.name : currentNameId;
    return { kind: 'refuse', message: `${target.name} is not an evolution of ${from}` };
}

/** The ids in `moves` that `@pkmn` does not know, in order. */
export function unknownMoveIds(moves: readonly string[]): string[] {
    return moves.filter(move => !gen4.moves.get(move).exists);
}
