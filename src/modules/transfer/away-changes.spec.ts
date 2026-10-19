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
    });

    it.each([
        ['a devolution', 'raichu', 'pikachu'],
        ['an unrelated species', 'pikachu', 'charizard'],
        ['a sibling branch', 'vaporeon', 'jolteon'],
        ['an unknown species', 'pikachu', 'notapokemon'],
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
