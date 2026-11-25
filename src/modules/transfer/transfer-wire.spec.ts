import {
    BrobotDepartRequestSchema,
    BrobotPokemonListResponseSchema,
    BrobotPokemonResponseSchema,
    BrobotPokemonSchema,
    BrobotReturnRequestSchema,
} from '@singularity/pmd-contracts';
import type { BrobotDepartRequest, BrobotReturnRequest } from '@singularity/pmd-contracts';
import { z } from 'zod';
import { OLD_ROWS, oldRow } from '../../../test/fixtures/prisma-import/old-rows';
import { GLOBAL_PREFIX } from '../../bootstrap';
import { Pokemon } from '../../entities/pokemon.entity';
import {
    BrobotTransferPokemon,
    BrobotTransferPokemonList,
    BrobotTransferPokemonResponse,
    departPokemon,
    listUserTransferPokemon,
    returnPokemon,
} from '../../http/transfer';
import { mapPokemon } from './import/prisma-row-mappers';
import type { RawRow } from './import/old-schema';
import { toTransferPokemon } from './transfer.service';

/**
 * brobot's `/api/internal/transfer/*` held to the wire api-time speaks:
 * `libs/pmd-shared/pmd-contracts/src/transfer.ts`, which api-time's
 * `src/app-modules/brobot/brobot-client.service.ts` validates every body it
 * sends and every answer it reads with.
 *
 * brobot keeps its own, looser route schemas (`src/http/transfer.ts`); this
 * spec is what makes the two drifting apart a test failure rather than a 400
 * (or a silently stripped field) in production. `@singularity/pmd-contracts`
 * is a devDependency for this file alone: the image never carries it.
 *
 * Known gaps, where pmd-contracts accepts a body brobot refuses, are listed in
 * `KNOWN_GAPS` and asserted to still be gaps, so that fixing either side
 * fails here until the entry moves into the accepted fixtures.
 */

// ── helpers ─────────────────────────────────────────────────────────────────

/** The issues a refusal carries, as `path: message`; `[]` when the value parses. */
function issues(schema: z.ZodType, value: unknown): string[] {
    const result = schema.safeParse(value);
    return result.success
        ? []
        : result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
}

/** The object schema under a pipe (a `.transform`) and an optional, or undefined. */
function objectOf(schema: z.ZodType): z.ZodObject | undefined {
    if (schema instanceof z.ZodPipe) return objectOf(schema.in as z.ZodType);
    if (schema instanceof z.ZodOptional) return objectOf(schema.unwrap() as z.ZodType);
    if (schema instanceof z.ZodNullable) return objectOf(schema.unwrap() as z.ZodType);
    return schema instanceof z.ZodObject ? schema : undefined;
}

/** Every property path an object schema declares, nested objects included (`species.nameId`). */
function keyPaths(schema: z.ZodType, prefix = ''): string[] {
    const object = objectOf(schema);
    if (!object) return [];
    return Object.entries(object.shape).flatMap(([key, value]) => [
        `${prefix}${key}`,
        ...keyPaths(value as z.ZodType, `${prefix}${key}.`),
    ]);
}

/** A cartesian product, for fixture matrices. */
function product<A, B>(as: readonly A[], bs: readonly B[]): [A, B][] {
    return as.flatMap(a => bs.map(b => [a, b] as [A, B]));
}

// ── (a) request bodies: every edge pmd-contracts accepts parses under the route ──

/**
 * `z.uuid()`'s edges: a v4 and a v7 (what `randomUUID()` and a time-ordered
 * mint send), upper case, and the nil and max uuids RFC 9562 also admits.
 */
const UUIDS = [
    '3f2b8c1e-9a4d-4e6b-8c2f-1d7a5e9b0c34',
    '01932c07-a8f1-7b3e-9c4d-5e6f7a8b9c0d',
    '3F2B8C1E-9A4D-4E6B-8C2F-1D7A5E9B0C34',
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
] as const;

/**
 * `twitchId: z.string().min(1)`, at its edge and in the shape api-time sends:
 * a Twitch user id (`twitch_user.oauth_id`), one digit to brobot's 32.
 * A non-numeric or longer string is a known gap (`KNOWN_GAPS`).
 */
const TWITCH_IDS = ['7', '4242', '9'.repeat(32)] as const;

const departFixtures: BrobotDepartRequest[] = product(TWITCH_IDS, UUIDS).map(
    ([twitchId, uuid], index) => ({
        twitchId,
        pmdRegisterId: uuid,
        nonce: UUIDS[(index + 1) % UUIDS.length],
    }),
);

/** `species`: absent, and at both ends of every bound. */
const SPECIES = [
    undefined,
    { nameId: 'a', name: 'A', dexNum: 1 },
    { nameId: 'charizard', name: 'Charizard', dexNum: 6 },
    { nameId: 'z9'.repeat(20), name: 'N'.repeat(40), dexNum: 1025 },
] as const;

/** `moves`: absent, one, and four of the longest id. */
const MOVES = [
    undefined,
    ['a'],
    ['flamethrower', 'airslash', 'dragonclaw', 'm'.repeat(40)],
] as const;

/** `level`: PMD's 1 and its cap, 100. */
const LEVELS = [1, 100] as const;

const returnFixtures: BrobotReturnRequest[] = product(product(LEVELS, SPECIES), MOVES).map(
    ([[level, species], moves], index) => ({
        twitchId: TWITCH_IDS[index % TWITCH_IDS.length],
        pmdRegisterId: UUIDS[index % UUIDS.length],
        level,
        // Absent, not undefined: api-time leaves an unchanged field out of the body.
        ...(species ? { species: { ...species } } : {}),
        ...(moves ? { moves: [...moves] } : {}),
        nonce: UUIDS[(index + 2) % UUIDS.length],
    }),
);

/** A fixture's edges, for its test name. */
function label(body: BrobotDepartRequest | BrobotReturnRequest): string {
    const parts = [
        `twitchId of ${body.twitchId.length}`,
        `register ${body.pmdRegisterId.slice(0, 8)}…`,
    ];
    if ('level' in body) {
        parts.push(`level ${body.level}`);
        parts.push(
            body.species ? `species ${body.species.nameId} #${body.species.dexNum}` : 'no species',
        );
        parts.push(body.moves ? `${body.moves.length} move(s)` : 'no moves');
    }
    return parts.join(', ');
}

describe('the transfer request bodies take everything pmd-contracts sends', () => {
    it('the fixtures are bodies pmd-contracts accepts, and cover its optional fields both ways', () => {
        for (const body of departFixtures)
            expect(issues(BrobotDepartRequestSchema, body)).toEqual([]);
        for (const body of returnFixtures)
            expect(issues(BrobotReturnRequestSchema, body)).toEqual([]);
        expect(returnFixtures.some(body => 'species' in body)).toBe(true);
        expect(returnFixtures.some(body => !('species' in body))).toBe(true);
        expect(returnFixtures.some(body => 'moves' in body)).toBe(true);
        expect(returnFixtures.some(body => !('moves' in body))).toBe(true);
        expect(new Set(returnFixtures.map(body => body.level))).toEqual(new Set([1, 100]));
    });

    it.each(departFixtures.map(body => [label(body), body] as const))(
        'depart takes %s, unchanged',
        (_, body) => {
            expect(issues(departPokemon.body, body)).toEqual([]);
            expect(departPokemon.body.parse(body)).toEqual(body);
        },
    );

    it.each(returnFixtures.map(body => [label(body), body] as const))(
        'return takes %s, and keeps what it applies',
        (_, body) => {
            expect(issues(returnPokemon.body, body)).toEqual([]);
            expect(returnPokemon.body.parse(body)).toEqual({
                twitchId: body.twitchId,
                pmdRegisterId: body.pmdRegisterId,
                pmdLevel: body.level,
                nonce: body.nonce,
                species: body.species ? { nameId: body.species.nameId } : null,
                moves: body.moves ?? null,
            });
        },
    );

    // brobot's bodies are `z.object`: a field pmd-contracts adds or renames
    // would be dropped without an error. Every field it declares is one brobot
    // declares too.
    it("depart declares every field pmd-contracts' BrobotDepartRequestSchema does", () => {
        const brobot = keyPaths(departPokemon.body);
        expect(keyPaths(BrobotDepartRequestSchema).filter(key => !brobot.includes(key))).toEqual(
            [],
        );
    });

    it("return declares every field pmd-contracts' BrobotReturnRequestSchema does", () => {
        const brobot = keyPaths(returnPokemon.body);
        expect(keyPaths(BrobotReturnRequestSchema).filter(key => !brobot.includes(key))).toEqual(
            [],
        );
    });
});

/**
 * Bodies pmd-contracts accepts and brobot refuses (with a 400). Each is a
 * finding, reported and not fixed here. Each case asserts the gap is still
 * there, so a fix on either side fails it: then move the body into the
 * fixtures above (brobot widened) or delete the entry (pmd-contracts narrowed).
 */
const KNOWN_GAPS: {
    gap: string;
    route: typeof departPokemon | typeof returnPokemon;
    contract: z.ZodType;
    body: object;
    refusal: string[];
}[] = [
    {
        gap: 'depart: a non-numeric twitchId (pmd-contracts: any non-empty string; brobot: 1–32 digits)',
        route: departPokemon,
        contract: BrobotDepartRequestSchema,
        body: { twitchId: 'a', pmdRegisterId: UUIDS[0], nonce: UUIDS[1] },
        refusal: ['twitchId: must be a Twitch user id'],
    },
    {
        gap: 'depart: a 33-digit twitchId (pmd-contracts: no maximum; brobot: 32)',
        route: departPokemon,
        contract: BrobotDepartRequestSchema,
        body: { twitchId: '9'.repeat(33), pmdRegisterId: UUIDS[0], nonce: UUIDS[1] },
        refusal: ['twitchId: must be a Twitch user id'],
    },
    {
        gap: 'return: a non-numeric twitchId (pmd-contracts: any non-empty string; brobot: 1–32 digits)',
        route: returnPokemon,
        contract: BrobotReturnRequestSchema,
        body: { twitchId: 'a', pmdRegisterId: UUIDS[0], level: 1, nonce: UUIDS[1] },
        refusal: ['twitchId: must be a Twitch user id'],
    },
    {
        gap: 'return: a 33-digit twitchId (pmd-contracts: no maximum; brobot: 32)',
        route: returnPokemon,
        contract: BrobotReturnRequestSchema,
        body: { twitchId: '9'.repeat(33), pmdRegisterId: UUIDS[0], level: 1, nonce: UUIDS[1] },
        refusal: ['twitchId: must be a Twitch user id'],
    },
];

describe('known gaps: bodies pmd-contracts accepts and brobot still refuses', () => {
    it.each(KNOWN_GAPS.map(gap => [gap.gap, gap] as const))('%s', (_, gap) => {
        expect(issues(gap.contract, gap.body), 'pmd-contracts no longer accepts it').toEqual([]);
        expect(issues(gap.route.body, gap.body), 'brobot now accepts it').toEqual(gap.refusal);
    });
});

// ── (b) paths: the URL api-time builds is the route's ──────────────────────

/**
 * The calls api-time's `BrobotClientService` makes: it joins `BROBOT_API_URL`,
 * `/api/internal/transfer` and one of these paths. `path` is its builder,
 * verbatim; `template` the same path with its argument as a placeholder.
 */
const API_TIME_PREFIX = '/api/internal/transfer';
const API_TIME_CALLS = [
    {
        method: 'get',
        route: listUserTransferPokemon,
        template: '/users/{twitchId}/pokemon',
        path: (twitchId: string) => `/users/${encodeURIComponent(twitchId)}/pokemon`,
        params: { twitchId: '4242' },
        arg: '4242',
    },
    {
        method: 'post',
        route: departPokemon,
        template: '/pokemon/{id}/depart',
        path: (brobotId: string) => `/pokemon/${encodeURIComponent(brobotId)}/depart`,
        params: { id: UUIDS[0] },
        arg: UUIDS[0],
    },
    {
        method: 'post',
        route: returnPokemon,
        template: '/pokemon/{id}/return',
        path: (brobotId: string) => `/pokemon/${encodeURIComponent(brobotId)}/return`,
        params: { id: UUIDS[0] },
        arg: UUIDS[0],
    },
] as const;

/** A route's path as Nest serves it, its `{param}` placeholders filled in. */
function served(path: string, params: Record<string, string>): string {
    return `/${GLOBAL_PREFIX}${path}`.replace(/\{(\w+)\}/g, (_, name: string) => {
        const value = params[name];
        if (value === undefined) throw new Error(`no value for {${name}} in ${path}`);
        return encodeURIComponent(value);
    });
}

describe("the transfer routes are at the paths api-time's client builds", () => {
    it.each(API_TIME_CALLS.map(call => [call.route.operationId, call] as const))(
        '%s',
        (_, call) => {
            expect(call.route.method).toBe(call.method);
            expect(`${API_TIME_PREFIX}${call.template}`).toBe(
                `/${GLOBAL_PREFIX}${call.route.path}`,
            );
            // And a real call: the same URL, with a value the route's params accept.
            expect(`${API_TIME_PREFIX}${call.path(call.arg)}`).toBe(
                served(call.route.path, call.params),
            );
            expect(issues(call.route.params, call.params)).toEqual([]);
        },
    );
});

// ── (c) answers: a real row, as brobot answers it, parses under pmd-contracts ──

const AWAY_REGISTER = '5d1c8f2a-3b4e-4c6d-8e9f-0a1b2c3d4e5f';

/** An imported row (the old-Prisma fixture through the importer's mapper) as the entity brobot reads. */
function rowFrom(raw: RawRow, overrides: Partial<Pokemon> = {}): Pokemon {
    const { team: _team, twitch_user: _user, ...data } = mapPokemon(raw);
    return Object.assign(new Pokemon(), data, overrides);
}

const ROWS: [string, Pokemon][] = [
    // Level 150 (above PMD's cap: brobot's are unbounded), shiny, holding an item.
    ['the fixture Pikachu, at home', rowFrom(OLD_ROWS.Pokemon)],
    [
        'a level-1 genderless one with no item, moves or battles (the old "no item" is \'\')',
        rowFrom(
            oldRow('Pokemon', {
                id: '1e2d3c4b-5a69-4788-9a0b-c1d2e3f4a5b6',
                name: 'Ditto',
                nameId: 'ditto',
                dexNum: '132',
                level: '1',
                shiny: 'f',
                gender: 'N',
                item: '',
                moves: '{}',
                types: '{Normal}',
                wins: '0',
                losses: '0',
                draws: '0',
                ability: 'Limber',
            }),
        ),
    ],
    [
        'the fixture Pikachu, away in PMD',
        rowFrom(OLD_ROWS.Pokemon, {
            slot: null,
            active_game: 'pmd',
            pmd_register_id: AWAY_REGISTER,
            pmd_first_transferred_at: new Date('2026-10-30T12:00:00Z'),
            level_at_departure: 150,
        }),
    ],
    [
        'the fixture Pikachu, home again (keeps its register id)',
        rowFrom(OLD_ROWS.Pokemon, {
            level: 151,
            pmd_register_id: AWAY_REGISTER,
            level_at_departure: 150,
        }),
    ],
];

describe("brobot's answers parse under pmd-contracts' BrobotPokemonSchema", () => {
    it.each(ROWS)('%s', (_, row) => {
        const pokemon = toTransferPokemon(row);
        // What the route documents it answers…
        expect(issues(BrobotTransferPokemon, pokemon)).toEqual([]);
        // …is what api-time accepts, field for field.
        expect(issues(BrobotPokemonSchema, pokemon)).toEqual([]);
        expect(BrobotPokemonSchema.parse(pokemon)).toEqual(pokemon);
    });

    it("the list and the transitions' envelopes parse under pmd-contracts' response schemas", () => {
        const pokemon = ROWS.map(([, row]) => toTransferPokemon(row));
        expect(issues(BrobotTransferPokemonList, { pokemon })).toEqual([]);
        expect(issues(BrobotPokemonListResponseSchema, { pokemon })).toEqual([]);
        expect(issues(BrobotPokemonListResponseSchema, { pokemon: [] })).toEqual([]);
        for (const one of pokemon) {
            expect(issues(BrobotTransferPokemonResponse, { pokemon: one })).toEqual([]);
            expect(issues(BrobotPokemonResponseSchema, { pokemon: one })).toEqual([]);
        }
    });

    it('brobot answers exactly the fields pmd-contracts declares', () => {
        expect(keyPaths(BrobotTransferPokemon).sort()).toEqual(
            keyPaths(BrobotPokemonSchema).sort(),
        );
    });
});
