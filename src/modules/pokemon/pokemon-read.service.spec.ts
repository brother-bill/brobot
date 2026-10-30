import type { EntityManager } from '@mikro-orm/postgresql';
import type { ActiveGame, Pokemon } from '../../entities';
import { PokemonReadService } from './pokemon-read.service';

function row(name: string, slot: number | null, active_game: ActiveGame = 'brobot'): Pokemon {
    return {
        name,
        name_id: name.toLowerCase(),
        slot,
        level: 81,
        shiny: false,
        wins: 0,
        losses: 0,
        draws: 0,
        item: '',
        moves: ['tackle'],
        dex_num: 383,
        color: 'Red',
        types: ['Ground'],
        gender: 'N',
        nature: 'Adamant',
        ability: 'Drought',
        active_game,
        created_date: new Date('2026-10-01T00:00:00Z'),
        updated_date: new Date('2026-10-29T00:00:00Z'),
    } as Pokemon;
}

function serviceWith(team: Pokemon[]): PokemonReadService {
    const user = { display_name: 'lebrotherbill', pokemon_team: { pokemon: { getItems: () => team } } };
    const em = { fork: () => em, findOne: async () => user };
    return new PokemonReadService(em as unknown as EntityManager);
}

describe('PokemonReadService.teamByOauthId', () => {
    it('keeps Pokémon away in PMD on the team page, after the slotted team and with slot null', async () => {
        const service = serviceWith([row('Groudon', null, 'pmd'), row('Onix', 3), row('Pikachu', 1), row('Kyogre', null, 'pmd')]);
        const response = await service.teamByOauthId('42');
        expect(response?.pokemonTeam?.pokemon.map(pokemon => [pokemon.slot, pokemon.name, pokemon.activeGame])).toEqual([
            [1, 'Pikachu', 'brobot'],
            [3, 'Onix', 'brobot'],
            [null, 'Groudon', 'pmd'],
            [null, 'Kyogre', 'pmd'],
        ]);
    });

    it('answers the team page shape', async () => {
        const response = await serviceWith([row('Groudon', null, 'pmd')]).teamByOauthId('42');
        expect(response).toEqual({
            displayName: 'lebrotherbill',
            pokemonTeam: {
                pokemon: [
                    {
                        name: 'Groudon',
                        nameId: 'groudon',
                        slot: null,
                        level: 81,
                        shiny: false,
                        wins: 0,
                        losses: 0,
                        draws: 0,
                        item: '',
                        moves: ['tackle'],
                        dexNum: 383,
                        color: 'Red',
                        types: ['Ground'],
                        gender: 'N',
                        nature: 'Adamant',
                        ability: 'Drought',
                        activeGame: 'pmd',
                        createdDate: '2026-10-01T00:00:00.000Z',
                        updatedDate: '2026-10-29T00:00:00.000Z',
                    },
                ],
            },
        });
    });
});
