/**
 * `/pokemon/*` (`modules/pokemon/pokemon.controller.ts`): the admin site's
 * public Pokémon pages. Public because they were public in the old app
 * (`!pokemon team` links viewers to them).
 */
import { defineRoute } from '@singularity/http-contract';
import { z } from 'zod';
import { ACTIVE_GAMES } from '../entities/pokemon.entity';
import { BrobotError, tooManyRequests, validationFailed } from './common';

export const BrobotActiveGame = z.enum(ACTIVE_GAMES).meta({
    id: 'BrobotActiveGame',
    description: 'Which game may use the Pokémon: `pmd` while it is away in pmd-online.',
});

export const BrobotLeaderboardEntry = z
    .strictObject({
        level: z.int(),
        name: z.string(),
        nameId: z.string(),
        shiny: z.boolean(),
        activeGame: BrobotActiveGame,
        twitchUser: z.strictObject({ displayName: z.string() }),
    })
    .meta({
        id: 'BrobotLeaderboardEntry',
        description: 'One Pokémon on the leaderboard (`LeaderboardEntry`).',
    });

export const BrobotTeamPokemon = z
    .strictObject({
        name: z.string(),
        nameId: z.string(),
        slot: z
            .int()
            .nullable()
            .meta({
                description:
                    '1–6; null while away in PMD (an away Pokémon holds no slot), and those come last',
            }),
        level: z.int(),
        shiny: z.boolean(),
        wins: z.int(),
        losses: z.int(),
        draws: z.int(),
        item: z.string(),
        moves: z.array(z.string()),
        dexNum: z.int(),
        color: z.string(),
        types: z.array(z.string()),
        gender: z.string(),
        nature: z.string(),
        ability: z.string(),
        activeGame: BrobotActiveGame,
        createdDate: z.iso.datetime(),
        updatedDate: z.iso.datetime(),
    })
    .meta({
        id: 'BrobotTeamPokemon',
        description:
            'A Pokémon as the team page shows it (`TeamPokemon`). No ids: the old endpoint hid them too.',
    });

export const BrobotTeamResponse = z
    .strictObject({
        displayName: z.string(),
        pokemonTeam: z
            .strictObject({ pokemon: z.array(BrobotTeamPokemon) })
            .nullable()
            .meta({ description: 'Null when the user exists but has never had a team' }),
    })
    .meta({ id: 'BrobotTeamResponse', description: "A user's team (`TeamResponse`)." });

export const BrobotBattleOutcome = z
    .strictObject({
        outcome: z
            .array(z.string())
            .meta({
                description:
                    'The battle log lines, oldest first. Empty when no battle has been fought yet.',
            }),
        updatedDate: z.iso.datetime().nullable(),
    })
    .meta({ id: 'BrobotBattleOutcome', description: 'The last battle (`BattleOutcomeResponse`).' });

export const getLeaderboard = defineRoute({
    operationId: 'getLeaderboard',
    method: 'get',
    path: '/pokemon/leaderboard',
    tags: ['Pokemon'],
    summary: 'The highest-level Pokémon',
    description: 'Highest levels first; ties go to the Pokémon that got there first.',
    responses: {
        200: { description: 'The leaderboard', body: z.array(BrobotLeaderboardEntry) },
        429: tooManyRequests,
    },
});

export const getTeam = defineRoute({
    operationId: 'getTeam',
    method: 'get',
    path: '/pokemon/teams',
    tags: ['Pokemon'],
    summary: "A user's team, by Twitch login",
    description: '10 lookups per client per minute, on top of a 60 s per-login cache.',
    query: z.object({
        login: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9_]{1,25}$/, 'must be a Twitch login')
            .meta({
                description:
                    'A Twitch login: 1–25 of `[A-Za-z0-9_]`; anything else cannot exist and never reaches Twitch',
            }),
    }),
    responses: {
        200: { description: 'The team', body: BrobotTeamResponse },
        400: validationFailed,
        404: { description: 'No brobot user with that login', body: BrobotError },
        429: { description: 'Throttled: over 10 lookups per client per minute', body: BrobotError },
        502: { description: 'The Twitch lookup failed', body: BrobotError },
    },
});

export const getBattleOutcome = defineRoute({
    operationId: 'getBattleOutcome',
    method: 'get',
    path: '/pokemon/battle-outcome',
    tags: ['Pokemon'],
    summary: 'The last one-on-one battle',
    responses: {
        200: { description: 'The battle log', body: BrobotBattleOutcome },
        429: tooManyRequests,
    },
});

export const getTeamBattleOutcome = defineRoute({
    operationId: 'getTeamBattleOutcome',
    method: 'get',
    path: '/pokemon/team-battle-outcome',
    tags: ['Pokemon'],
    summary: 'The last team battle',
    responses: {
        200: { description: 'The battle log', body: BrobotBattleOutcome },
        429: tooManyRequests,
    },
});

export const pokemonRoutes = [
    getLeaderboard,
    getTeam,
    getBattleOutcome,
    getTeamBattleOutcome,
] as const;
