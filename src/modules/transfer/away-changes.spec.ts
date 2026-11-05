import { evolutionOnReturn, unknownMoveIds } from './away-changes';

describe('evolutionOnReturn — only forward evolutions, per @pkmn prevo chains', () => {
    it('evolves one step, recomputing every species column from @pkmn', () => {
        expect(evolutionOnReturn('charmeleon', 'charizard')).toEqual({
            kind: 'evolve',
            columns: {
                name: 'Charizard',
                name_id: 'charizard',
                dex_num: 6,
                types: ['Fire', 'Flying'],
                color: 'Red',
            },
        });
    });

    it.each([
        ['two steps at once', 'pichu', 'raichu'],
        ['into a regional form', 'pikachu', 'raichualola'],
        ['into a species from a later generation', 'eevee', 'sylveon'],
        ['into a gender forme', 'espurr', 'meowsticf'],
        ['from a regional form along its own chain', 'rattataalola', 'raticatealola'],
        ['a cosmetic forme into the same forme', 'shelloseast', 'gastrodoneast'],
        ['a cosmetic forme into the same forme, two steps at once', 'flabebeblue', 'florgesblue'],
        ['a cosmetic forme into a species without it', 'burmytrash', 'mothim'],
        ['a base species into an evolution without formes', 'burmy', 'mothim'],
        ['a base species into the base forme', 'shellos', 'gastrodon'],
    ])('evolves %s', (_label, from, to) => {
        expect(evolutionOnReturn(from, to)).toMatchObject({
            kind: 'evolve',
            columns: { name_id: to },
        });
    });

    it('reads types from the generation-4 dex the rows are created from', () => {
        expect(evolutionOnReturn('clefairy', 'clefable')).toMatchObject({
            kind: 'evolve',
            columns: { types: ['Normal'] },
        });
    });

    it('treats the row’s own species as no change', () => {
        expect(evolutionOnReturn('pikachu', 'pikachu')).toEqual({ kind: 'same' });
        expect(evolutionOnReturn('squawkabillyblue', 'squawkabillyblue')).toEqual({ kind: 'same' });
    });

    it('keeps the forme’s own columns, not its base species’', () => {
        expect(evolutionOnReturn('pikachu', 'raichualola')).toEqual({
            kind: 'evolve',
            columns: {
                name: 'Raichu-Alola',
                name_id: 'raichualola',
                dex_num: 26,
                types: ['Electric', 'Psychic'],
                color: 'Brown',
            },
        });
    });

    it.each([
        ['a devolution', 'raichu', 'pikachu'],
        ['an unrelated species', 'pikachu', 'charizard'],
        ['a sibling branch', 'vaporeon', 'jolteon'],
        ['an unknown species', 'pikachu', 'notapokemon'],
        ['a forme change that is no evolution', 'squawkabilly', 'squawkabillyblue'],
        ['a regional form from the other region’s chain', 'rattata', 'raticatealola'],
        ['a cosmetic forme into a different one', 'shelloseast', 'gastrodon'],
        ['a base species into a cosmetic forme', 'shellos', 'gastrodoneast'],
        ['a base species into a cosmetic forme, two steps at once', 'flabebe', 'florgesblue'],
        ['a Mega Evolution', 'raichu', 'raichumegax'],
    ])('refuses %s', (_label, from, to) => {
        expect(evolutionOnReturn(from, to)).toMatchObject({ kind: 'refuse' });
    });
});

describe('unknownMoveIds', () => {
    it('names only the ids @pkmn does not know', () => {
        expect(
            unknownMoveIds(['thunderbolt', 'alluringvoice', 'notamove', 'hiddenpowerfire']),
        ).toEqual(['notamove']);
    });
});
