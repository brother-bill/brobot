import { Injectable } from '@nestjs/common';
import { Dex } from '@pkmn/sim';
import type { Species } from '@pkmn/sim';
import { GEN4_DROPS_POKEDEX, GEN4_POKEDEX } from './poke-info';
import { Random } from './random';

/** The last national dex number of generation 4 (Arceus). */
export const GEN4_LAST_DEX_NUM = 493;

/** Everything a new `pokemon` row needs apart from its owner, team and slot. */
export interface NewPokemon {
    name: string;
    name_id: string;
    level: number;
    shiny: boolean;
    gender: 'M' | 'F' | 'N';
    moves: string[];
    color: string;
    dex_num: number;
    types: string[];
    nature: string;
    ability: string;
}

/** A name a viewer (or an admin) typed that is not a generation-1–4 species. */
export class UnknownSpeciesError extends Error {
    constructor(name: string) {
        super(`Pokemon ${name} does not exist`);
        this.name = 'UnknownSpeciesError';
    }
}

const gen4 = Dex.forGen(4);

/**
 * Rolls new Pokémon the way the old `PokemonService` did: a random species
 * from the right dex, a random nature and ability, gender by the species'
 * ratio, and the species' learnset as its moves.
 *
 * One deliberate difference: `Dex.forGen(4).learnsets` lists moves from every
 * generation (a gen-4 Pikachu "knew" Alluring Voice), so moves are now limited
 * to those learnable in generations 1–4. Rows created by the old bot keep
 * the moves they have.
 */
@Injectable()
export class PokemonFactory {
    constructor(private readonly random: Random) {}

    /** A `Pokemon Create` redeem: any generation 1–4 species, level 1, 1-in-250 shiny. */
    async randomFromDex(): Promise<NewPokemon> {
        return this.build(this.species(this.random.pick(GEN4_POKEDEX)), 1, this.random.oneIn(250));
    }

    /** A chat drop: one of the drop species, level 1, 1-in-8 shiny. */
    async randomDrop(): Promise<NewPokemon> {
        return this.build(this.species(this.random.pick(GEN4_DROPS_POKEDEX)), 1, this.random.oneIn(8));
    }

    /** `!pokemon create`: an admin names the species, level and shininess. */
    async specific(name: string, level: number, shiny: boolean): Promise<NewPokemon> {
        const species = gen4.species.get(name);
        if (!species.exists || species.isNonstandard || species.num < 1 || species.num > GEN4_LAST_DEX_NUM) {
            throw new UnknownSpeciesError(name);
        }
        return this.build(species, level, shiny);
    }

    private species(name: string): Species {
        const species = gen4.species.get(name);
        if (!species.exists) throw new UnknownSpeciesError(name);
        return species;
    }

    private async build(species: Species, level: number, shiny: boolean): Promise<NewPokemon> {
        return {
            name: species.name,
            name_id: species.id,
            level,
            shiny,
            gender: this.gender(species),
            moves: await movesOf(species),
            color: species.color,
            dex_num: species.num,
            types: [...species.types],
            nature: this.random.pick(gen4.natures.all().filter(nature => !nature.isNonstandard)).name,
            ability: this.random.pick(Object.values(species.abilities)),
        };
    }

    /** Fixed-gender species (Nidoran-F, legendaries = N) keep theirs; the rest roll by ratio. */
    private gender(species: Species): 'M' | 'F' | 'N' {
        if (species.gender) return species.gender;
        return this.random.int(0, 100) <= species.genderRatio.M * 100 ? 'M' : 'F';
    }
}

/** The species' generation 1–4 learnset, as `@pkmn` move ids. */
export async function movesOf(species: Species): Promise<string[]> {
    const { learnset } = await gen4.learnsets.get(species.id);
    if (!learnset) return [];
    return Object.entries(learnset)
        .filter(([, sources]) => sources.some(source => Number.parseInt(source, 10) <= 4))
        .map(([move]) => move);
}
