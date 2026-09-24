import { ReferenceKind } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../../mikro-orm.config';
import { OLD_ROWS, oldRow } from '../../../../test/fixtures/prisma-import/old-rows';
import { OLD_TABLE_NAMES, OLD_TABLES } from './old-schema';
import type { OldTable } from './old-schema';
import {
    mapBattleOutcome,
    mapPokemon,
    mapPokemonTeam,
    mapTwitchToken,
    mapTwitchUser,
    mapTwitchUserRegistered,
    ROW_MAPPERS,
    RowMappingError,
} from './prisma-row-mappers';
import { newTableFor } from './prisma-import';

describe('fixtures', () => {
    it.each(OLD_TABLE_NAMES)('%s fixture has exactly the old schema’s columns', table => {
        expect(Object.keys(OLD_ROWS[table]).sort()).toEqual([...OLD_TABLES[table]].sort());
    });
});

describe('row mappers', () => {
    it('TwitchUser → twitch_user: the Twitch id stays the key, roles kept verbatim', () => {
        expect(
            mapTwitchUser(oldRow('TwitchUser', { roles: '{Viewer,StreamerAuth,SomethingOld}' })),
        ).toEqual({
            oauth_id: '42',
            display_name: 'AshKetchum',
            created_date: new Date('2022-11-30T13:00:00Z'),
            roles: ['Viewer', 'StreamerAuth', 'SomethingOld'],
            updated_date: new Date('2023-04-01T09:15:00.250Z'),
        });
    });

    it('TwitchUser with NULL roles gets the column default', () => {
        expect(mapTwitchUser(oldRow('TwitchUser', { roles: null })).roles).toEqual(['Viewer']);
    });

    it('TwitchUserRegistered keeps a NULL email and maps the dates', () => {
        expect(mapTwitchUserRegistered(oldRow('TwitchUserRegistered', { email: null }))).toEqual({
            id: 'c1c1c1c1-2222-4333-8444-555566667777',
            twitch_user: '42',
            email: null,
            profile_image_url: 'https://static-cdn.jtvnw.net/ash.png',
            scope: ['user:read:email'],
            updated_date: new Date('2023-01-01T00:00:00Z'),
            origin_date: new Date('2016-01-02T03:04:05Z'),
            registered_date: new Date('2022-12-01T00:00:00Z'),
        });
    });

    it.each(['TwitchBotAuth', 'TwitchStreamerAuth'] as const)(
        '%s: bigint epoch → number, NULL scope → []',
        table => {
            const mapped = mapTwitchToken(oldRow(table, { scope: null }));
            expect(mapped).toMatchObject({
                id: OLD_ROWS[table].id,
                twitch_user: '42',
                expiry_seconds: 14400,
                scope: [],
                obtainment_epoch: Number(OLD_ROWS[table].obtainmentEpoch),
            });
        },
    );

    it('PokemonTeam', () => {
        expect(mapPokemonTeam(oldRow('PokemonTeam'))).toEqual({
            id: '5b7d1f0e-6a51-4c1f-9d0a-0b8f3c2a4e11',
            twitch_user: '42',
            created_date: new Date('2022-11-30T13:06:40.100Z'),
            updated_date: new Date('2023-04-01T09:15:00Z'),
        });
    });

    it('Pokemon → pokemon, at home in brobot, level uncapped', () => {
        expect(mapPokemon(oldRow('Pokemon'))).toEqual({
            id: '0f6f8a4e-2b1c-4d3e-8f9a-1b2c3d4e5f60',
            name: 'Pikachu',
            name_id: 'pikachu',
            slot: 1,
            level: 150,
            shiny: true,
            wins: 31,
            losses: 4,
            draws: 2,
            item: 'Light Ball',
            moves: ['thunderbolt', 'quickattack'],
            dex_num: 25,
            color: 'Yellow',
            types: ['Electric'],
            gender: 'F',
            nature: 'Jolly',
            ability: 'Static',
            team: '5b7d1f0e-6a51-4c1f-9d0a-0b8f3c2a4e11',
            twitch_user: '42',
            created_date: new Date('2022-11-30T13:06:40.123Z'),
            updated_date: new Date('2023-04-01T09:15:00.500Z'),
            active_game: 'brobot',
        });
    });

    it('Pokemon: NULL arrays become [], no team is kept as null, ids are lower-cased', () => {
        expect(
            mapPokemon(
                oldRow('Pokemon', {
                    moves: null,
                    types: null,
                    teamId: null,
                    id: '0F6F8A4E-2B1C-4D3E-8F9A-1B2C3D4E5F60',
                    shiny: 'false',
                }),
            ),
        ).toMatchObject({
            moves: [],
            types: [],
            team: null,
            id: '0f6f8a4e-2b1c-4d3e-8f9a-1b2c3d4e5f60',
            shiny: false,
        });
    });

    it.each(['PokemonBattleOutcome', 'PokemonTeamBattleOutcome'] as const)('%s', table => {
        expect(mapBattleOutcome(oldRow(table)).outcome).toEqual(
            table === 'PokemonBattleOutcome'
                ? ['Pikachu used Thunderbolt!', "It's super effective"]
                : [],
        );
    });

    it('reads timestamps as UTC, or at their explicit offset', () => {
        const at = (value: string) =>
            mapPokemonTeam(
                oldRow('PokemonTeam', { createdDate: value }),
            ).created_date.toISOString();
        expect(at('2022-11-30 13:06:40')).toBe('2022-11-30T13:06:40.000Z');
        expect(at('2022-11-30 13:06:40.123456')).toBe('2022-11-30T13:06:40.123Z');
        expect(at('2022-11-30 13:06:40+02')).toBe('2022-11-30T11:06:40.000Z');
        expect(at('2022-11-30T13:06:40.5-05:30')).toBe('2022-11-30T18:36:40.500Z');
    });

    describe('refuses what the new schema cannot hold', () => {
        it.each<[string, OldTable, Record<string, string | null>, RegExp]>([
            ['a slot of 0', 'Pokemon', { slot: '0' }, /^slot: 0 is outside 1\.\.6/],
            ['a slot of 7', 'Pokemon', { slot: '7' }, /^slot: 7 is outside 1\.\.6/],
            ['a level of 0', 'Pokemon', { level: '0' }, /^level:/],
            ['negative wins', 'Pokemon', { wins: '-1' }, /^wins:/],
            ['an unknown gender', 'Pokemon', { gender: 'X' }, /^gender: "X" is not M, F or N/],
            ['a non-uuid id', 'Pokemon', { id: 'cl9x0abc' }, /^id: "cl9x0abc" is not a uuid/],
            ['a non-uuid teamId', 'Pokemon', { teamId: 'nope' }, /^teamId:/],
            ['a NULL name', 'Pokemon', { name: null }, /^name: is NULL/],
            [
                'a NULL element in moves',
                'Pokemon',
                { moves: '{tackle,NULL}' },
                /^moves: contains a NULL element/,
            ],
            ['a broken array', 'Pokemon', { types: 'Electric' }, /^types: not an array literal/],
            ['a bad boolean', 'Pokemon', { shiny: 'yes' }, /^shiny:/],
            ['a bad timestamp', 'Pokemon', { createdDate: 'yesterday' }, /^createdDate:/],
            ['an empty Twitch id', 'TwitchUser', { oauthId: '' }, /^oauthId: is empty/],
            [
                'an epoch past 2^53',
                'TwitchBotAuth',
                { obtainmentEpoch: '9007199254740993' },
                /^obtainmentEpoch:/,
            ],
            [
                'a missing column',
                'PokemonTeam',
                { updatedDate: undefined as unknown as null },
                /^updatedDate: column missing/,
            ],
        ])('%s', (_label, table, overrides, message) => {
            const row = oldRow(table, overrides);
            if (overrides.updatedDate === undefined && 'updatedDate' in overrides)
                delete row.updatedDate;
            expect(() => ROW_MAPPERS[table](row)).toThrow(RowMappingError);
            expect(() => ROW_MAPPERS[table](row)).toThrow(message);
        });
    });
});

/**
 * Every column the new entities persist is written by a mapper, except the
 * ones an imported row leaves at their defaults. Built from the ORM metadata,
 * so a column added to an entity without a mapper change fails here.
 */
describe('mapper coverage of the new entities', () => {
    let orm: MikroORM;

    beforeAll(async () => {
        orm = await MikroORM.init({
            ...buildOrmConfig('postgres://unused:unused@127.0.0.1:1/unused'),
            connect: false,
            logger: () => undefined,
        });
    });

    afterAll(async () => {
        await orm.close(true);
    });

    const LEFT_AT_DEFAULT: Partial<Record<OldTable, string[]>> = {
        Pokemon: ['pmd_register_id', 'pmd_first_transferred_at', 'level_at_departure'],
    };

    it.each(OLD_TABLE_NAMES)('%s', table => {
        const meta = Object.values(orm.getMetadata().getAll()).find(
            candidate => candidate.tableName === newTableFor(table),
        );
        if (!meta) throw new Error(`no entity for ${newTableFor(table)}`);
        const persisted = meta.props
            .filter(
                prop =>
                    prop.persist !== false &&
                    (prop.kind === ReferenceKind.SCALAR ||
                        prop.kind === ReferenceKind.MANY_TO_ONE ||
                        (prop.kind === ReferenceKind.ONE_TO_ONE && prop.owner)),
            )
            .map(prop => prop.name)
            .filter(name => !(LEFT_AT_DEFAULT[table] ?? []).includes(name))
            .sort();
        expect(Object.keys(ROW_MAPPERS[table](OLD_ROWS[table])).sort()).toEqual(persisted);
    });
});
