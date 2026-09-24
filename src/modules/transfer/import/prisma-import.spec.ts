import type { EntityManager } from '@mikro-orm/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pokemon, TwitchUser } from '../../../entities';
import { oldRow } from '../../../../test/fixtures/prisma-import/old-rows';
import type { OldTable, RawRow } from './old-schema';
import { parseCopyDump } from './pg-text';
import { applyImport, planImport } from './prisma-import';
import { RecordingEntityManager } from '../../../../test/fixtures/prisma-import/recording-entity-manager';

const FIXTURE = readFileSync(join(__dirname, '../../../../test/fixtures/prisma-import/old-prisma.data.sql'), 'utf8');

function source(tables: Partial<Record<OldTable, RawRow[]>>): Map<OldTable, RawRow[]> {
    return new Map(Object.entries(tables) as [OldTable, RawRow[]][]);
}

describe('planImport', () => {
    it('maps the whole fixture dump, parents first, with counts per table', () => {
        const plan = planImport(parseCopyDump(FIXTURE).tables, { continueOnFailure: false });
        expect(plan.aborted).toBe(false);
        expect(plan.failures).toEqual([]);
        expect(
            plan.report.map(entry => [
                entry.table,
                entry.newTable,
                entry.read,
                entry.mapped,
                entry.failed,
            ]),
        ).toEqual([
            ['TwitchUser', 'twitch_user', 4, 4, 0],
            ['TwitchUserRegistered', 'twitch_user_registered', 1, 1, 0],
            ['TwitchBotAuth', 'twitch_bot_auth', 1, 1, 0],
            ['TwitchStreamerAuth', 'twitch_streamer_auth', 1, 1, 0],
            ['PokemonTeam', 'pokemon_team', 2, 2, 0],
            ['Pokemon', 'pokemon', 5, 5, 0],
            ['PokemonBattleOutcome', 'pokemon_battle_outcome', 1, 1, 0],
            ['PokemonTeamBattleOutcome', 'pokemon_team_battle_outcome', 1, 1, 0],
        ]);
        expect(plan.rows.Pokemon.every(pokemon => pokemon.active_game === 'brobot')).toBe(true);
        expect(plan.rows.Pokemon.find(pokemon => pokemon.name_id === 'mrmime')?.moves).toEqual([
            'psychic',
            'barrier',
            'light screen',
        ]);
    });

    it('warns (does not fail) on two Pokémon sharing a team slot, as the old bot allowed', () => {
        const plan = planImport(parseCopyDump(FIXTURE).tables, { continueOnFailure: false });
        expect(plan.warnings).toEqual([
            expect.stringMatching(/^Pokemon: 1 \(team, slot\) pair\(s\).*#2 ×2$/),
        ]);
    });

    it('warns about a table the source does not have', () => {
        const plan = planImport(source({ TwitchUser: [oldRow('TwitchUser')] }), {
            continueOnFailure: false,
        });
        expect(plan.warnings).toContain('Pokemon: not in the source (0 rows)');
    });

    it('stops at the first row it cannot map, without --continue', () => {
        const plan = planImport(
            source({
                TwitchUser: [oldRow('TwitchUser')],
                PokemonTeam: [oldRow('PokemonTeam')],
                Pokemon: [
                    oldRow('Pokemon', { slot: '9' }),
                    oldRow('Pokemon', { id: '11111111-1111-4111-8111-111111111111', gender: 'X' }),
                ],
            }),
            { continueOnFailure: false },
        );
        expect(plan.aborted).toBe(true);
        expect(plan.failures).toEqual([
            {
                table: 'Pokemon',
                row: 1,
                key: '0f6f8a4e-2b1c-4d3e-8f9a-1b2c3d4e5f60',
                reason: 'slot: 9 is outside 1..6',
            },
        ]);
    });

    it('with --continue, skips bad rows and every row that depends on them', () => {
        const plan = planImport(
            source({
                TwitchUser: [
                    oldRow('TwitchUser', { createdDate: 'garbage' }),
                    oldRow('TwitchUser', { oauthId: '77' }),
                ],
                PokemonTeam: [
                    oldRow('PokemonTeam'),
                    oldRow('PokemonTeam', {
                        id: '22222222-2222-4222-8222-222222222222',
                        userOauthId: '77',
                    }),
                ],
                Pokemon: [
                    oldRow('Pokemon'),
                    oldRow('Pokemon', {
                        id: '33333333-3333-4333-8333-333333333333',
                        userOauthId: '77',
                        teamId: '5b7d1f0e-6a51-4c1f-9d0a-0b8f3c2a4e11',
                    }),
                    oldRow('Pokemon', {
                        id: '44444444-4444-4444-8444-444444444444',
                        userOauthId: '77',
                        teamId: '22222222-2222-4222-8222-222222222222',
                    }),
                ],
            }),
            { continueOnFailure: true },
        );
        expect(plan.aborted).toBe(false);
        expect(plan.failures.map(failure => [failure.table, failure.row, failure.reason])).toEqual([
            ['TwitchUser', 1, 'createdDate: "garbage" is not a timestamp'],
            ['PokemonTeam', 1, 'userOauthId: TwitchUser 42 is not being imported'],
            ['Pokemon', 1, 'userOauthId: TwitchUser 42 is not being imported'],
            [
                'Pokemon',
                2,
                'teamId: PokemonTeam 5b7d1f0e-6a51-4c1f-9d0a-0b8f3c2a4e11 is not being imported',
            ],
        ]);
        expect(plan.rows.Pokemon.map(pokemon => pokemon.id)).toEqual([
            '44444444-4444-4444-8444-444444444444',
        ]);
    });

    it('refuses duplicate keys and a second team for one user', () => {
        const plan = planImport(
            source({
                TwitchUser: [oldRow('TwitchUser'), oldRow('TwitchUser')],
                PokemonTeam: [
                    oldRow('PokemonTeam'),
                    oldRow('PokemonTeam', { id: '22222222-2222-4222-8222-222222222222' }),
                ],
            }),
            { continueOnFailure: true },
        );
        expect(plan.failures.map(failure => failure.reason)).toEqual([
            'oauthId: duplicate key 42',
            'userOauthId: a second PokemonTeam row for user 42',
        ]);
    });
});

describe('applyImport', () => {
    it('upserts parents first, in one transaction, keyed on the old ids, never touching transfer columns', async () => {
        const em = new RecordingEntityManager();
        const plan = planImport(parseCopyDump(FIXTURE).tables, { continueOnFailure: false });
        const written = await applyImport(em as unknown as EntityManager, plan);

        expect(em.transactions).toBe(1);
        expect(em.upserts.map(call => call.entity)).toEqual([
            'TwitchUser',
            'TwitchUserRegistered',
            'TwitchBotAuth',
            'TwitchStreamerAuth',
            'PokemonTeam',
            'Pokemon',
            'PokemonBattleOutcome',
            'PokemonTeamBattleOutcome',
        ]);
        expect(em.upserts[0].options).toEqual({
            onConflictFields: ['oauth_id'],
            onConflictAction: 'merge',
        });
        const pokemon = em.upserts.find(call => call.entity === Pokemon.name);
        expect(pokemon?.options).toEqual({
            onConflictFields: ['id'],
            onConflictAction: 'merge',
            onConflictExcludeFields: [
                'active_game',
                'pmd_register_id',
                'pmd_first_transferred_at',
                'level_at_departure',
            ],
        });
        expect(written).toMatchObject({ twitch_user: 4, pokemon: 5, pokemon_team: 2 });
    });

    it('chunks large tables', async () => {
        const em = new RecordingEntityManager();
        const users = Array.from({ length: 5 }, (_, i) =>
            oldRow('TwitchUser', { oauthId: String(100 + i) }),
        );
        await applyImport(
            em as unknown as EntityManager,
            planImport(source({ TwitchUser: users }), { continueOnFailure: false }),
            {
                chunkSize: 2,
            },
        );
        expect(
            em.upserts
                .filter(call => call.entity === TwitchUser.name)
                .map(call => call.rows.length),
        ).toEqual([2, 2, 1]);
    });

    it('refuses an aborted plan and lets a database error escape (the transaction rolls back)', async () => {
        const aborted = planImport(
            source({ TwitchUser: [oldRow('TwitchUser', { oauthId: null })] }),
            { continueOnFailure: false },
        );
        await expect(
            applyImport(new RecordingEntityManager() as unknown as EntityManager, aborted),
        ).rejects.toThrow(/aborted/);

        const em = new RecordingEntityManager();
        em.failOn = 'Pokemon';
        const plan = planImport(parseCopyDump(FIXTURE).tables, { continueOnFailure: false });
        await expect(applyImport(em as unknown as EntityManager, plan)).rejects.toThrow(
            'boom in Pokemon',
        );
    });
});
