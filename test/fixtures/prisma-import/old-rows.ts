import type { OldTable, RawRow } from '../../../src/modules/transfer/import/old-schema';

/**
 * One valid row per old Prisma table, keyed by exactly the column list of
 * the old schema (`OLD_TABLES`, from the init migration), with values as
 * Postgres prints them. Tests override single columns.
 */
export const OLD_ROWS: Record<OldTable, RawRow> = {
    TwitchUser: {
        oauthId: '42',
        displayName: 'AshKetchum',
        createdDate: '2022-11-30 13:00:00',
        roles: '{Viewer}',
        updatedDate: '2023-04-01 09:15:00.25',
    },
    TwitchUserRegistered: {
        id: 'c1c1c1c1-2222-4333-8444-555566667777',
        userOauthId: '42',
        email: 'ash@example.test',
        profileImageUrl: 'https://static-cdn.jtvnw.net/ash.png',
        scope: '{user:read:email}',
        updatedDate: '2023-01-01 00:00:00',
        originDate: '2016-01-02 03:04:05',
        registeredDate: '2022-12-01 00:00:00',
    },
    TwitchBotAuth: {
        id: 'b0b0b0b0-1111-4222-8333-444455556666',
        accessToken: 'bot-access',
        refreshToken: 'bot-refresh',
        scope: '{chat:read,chat:edit}',
        createdDate: '2022-11-30 12:00:00',
        expirySeconds: '14400',
        userOauthId: '42',
        updatedDate: '2023-05-03 03:00:00',
        obtainmentEpoch: '1683082800123',
    },
    TwitchStreamerAuth: {
        id: '5e5e5e5e-1111-4222-8333-444455556666',
        accessToken: 'streamer-access',
        refreshToken: 'streamer-refresh',
        scope: '{channel:read:redemptions}',
        createdDate: '2022-11-30 12:05:00',
        expirySeconds: '14400',
        userOauthId: '42',
        updatedDate: '2023-05-03 03:05:00',
        obtainmentEpoch: '1683083100456',
    },
    PokemonTeam: {
        id: '5b7d1f0e-6a51-4c1f-9d0a-0b8f3c2a4e11',
        userOauthId: '42',
        createdDate: '2022-11-30 13:06:40.1',
        updatedDate: '2023-04-01 09:15:00',
    },
    Pokemon: {
        id: '0f6f8a4e-2b1c-4d3e-8f9a-1b2c3d4e5f60',
        name: 'Pikachu',
        nameId: 'pikachu',
        slot: '1',
        level: '150',
        shiny: 't',
        wins: '31',
        losses: '4',
        draws: '2',
        item: 'Light Ball',
        moves: '{thunderbolt,quickattack}',
        dexNum: '25',
        color: 'Yellow',
        types: '{Electric}',
        gender: 'F',
        nature: 'Jolly',
        ability: 'Static',
        teamId: '5b7d1f0e-6a51-4c1f-9d0a-0b8f3c2a4e11',
        userOauthId: '42',
        createdDate: '2022-11-30 13:06:40.123',
        updatedDate: '2023-04-01 09:15:00.5',
    },
    PokemonBattleOutcome: {
        id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
        updatedDate: '2023-05-01 22:00:00',
        outcome: '{"Pikachu used Thunderbolt!","It\'s super effective"}',
    },
    PokemonTeamBattleOutcome: {
        id: '7c6d5e4f-3a2b-4c1d-9e0f-8a7b6c5d4e3f',
        updatedDate: '2023-05-02 21:00:00',
        outcome: '{}',
    },
};

export function oldRow(table: OldTable, overrides: RawRow = {}): RawRow {
    return { ...OLD_ROWS[table], ...overrides };
}
