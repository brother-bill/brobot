/**
 * `/internal/transfer/*` (`modules/transfer/transfer.controller.ts`):
 * api-time's side door into brobot (migration plan §2, §4). Bearer
 * `BROBOT_SERVICE_TOKEN` only, and unthrottled: every player's request
 * arrives from the one api-time host.
 *
 * The request schemas here are the only copy; `transfer.schemas.ts`
 * re-exports them for the service. The authoritative contract is
 * `libs/pmd-shared/pmd-contracts/src/transfer.ts` in the superproject (ticket A1): these
 * accept everything it sends, plus the ticket-B3 spelling of the return body
 * (`pmdLevel` for `level`, no `pmdRegisterId`). The return body's `species`
 * and `moves` mirror `BrobotReturnRequestSchema`'s.
 *
 * The bodies are `z.object`, not `z.strictObject`, on purpose: an unknown
 * field is dropped rather than refused, which pmd-contracts' header relies on
 * so that api-time and brobot can deploy in either order.
 */
import { defineRoute, doc } from '@singularity/http-contract';
import { z } from 'zod';
import { BrobotTransferError, unauthorized, validationFailed } from './common';
import { BrobotActiveGame } from './pokemon';
import { requires } from './security';
import { PMD_LEVEL_CAP } from '../modules/transfer/transfer-rules';

// ── request schemas ─────────────────────────────────────────────────────────

/** Twitch user ids are numeric strings (brobot's `twitch_user.oauth_id`). */
export const twitchIdSchema = z
    .string()
    .trim()
    .regex(/^\d{1,32}$/, 'must be a Twitch user id')
    .meta({ description: 'A Twitch user id: 1–32 digits' });

/** The caller's idempotency key. api-time sends a uuid; any short token is accepted. */
const nonceSchema = z
    .string()
    .trim()
    .min(1)
    .max(128)
    .meta({
        description: "The caller's idempotency key: a retry with the same nonce answers the same",
    });

const pmdLevelSchema = z.int().min(1).max(PMD_LEVEL_CAP);

/** A `@pkmn` (showdown) id, as pmd-contracts spells species and move ids on this wire. */
const pkmnIdSchema = z
    .string()
    .regex(/^[a-z0-9]+$/, 'must be a @pkmn id')
    .max(40);

export const pokemonIdParamSchema = z
    .uuid({ error: 'must be a brobot Pokémon id' })
    .meta({ description: "The Pokémon's brobot row uuid" });

export const twitchIdQuerySchema = z.object({ twitchId: twitchIdSchema });

export const departBodySchema = z
    .object({
        twitchId: twitchIdSchema,
        pmdRegisterId: z
            .uuid()
            .meta({ description: 'The pmd-online register row it travels under' }),
        nonce: nonceSchema,
    })
    .meta({ id: 'BrobotDepartRequest', description: 'Send a brobot Pokémon to pmd-online.' });
export type DepartBody = z.infer<typeof departBodySchema>;

export const returnBodySchema = z
    .object({
        twitchId: twitchIdSchema,
        /** api-time (A1) sends the register row it is returning from; checked against the row when present. */
        pmdRegisterId: z
            .uuid()
            .optional()
            .meta({
                description:
                    'The register row it returns from; checked against the row when present',
            }),
        /** PMD's level for it. `level` is the pmd-contracts spelling, `pmdLevel` the ticket's; send one. */
        pmdLevel: pmdLevelSchema
            .optional()
            .meta({
                description: "PMD's level for it (the ticket's spelling). Send this or `level`.",
            }),
        level: pmdLevelSchema
            .optional()
            .meta({
                description:
                    "PMD's level for it (pmd-contracts' spelling). Equal to `pmdLevel` when both are sent.",
            }),
        nonce: nonceSchema,
        /**
         * The species it evolved into while away. Only `nameId` decides
         * anything: brobot recomputes the other species columns from
         * `@pkmn`, so `name` and `dexNum` are validated and then ignored.
         */
        species: z
            .object({
                nameId: pkmnIdSchema,
                name: z.string().min(1).max(40),
                dexNum: z.int().min(1).max(1025),
            })
            .optional()
            .meta({
                description:
                    'The species it evolved into while away. Only `nameId` decides; `name` and `dexNum` are validated, then ignored.',
            }),
        /** The moveset it came back with, replacing the row's. */
        moves: z
            .array(pkmnIdSchema)
            .min(1)
            .max(4)
            .optional()
            .meta({ description: "The moveset it came back with, replacing the row's" }),
    })
    .refine(body => body.pmdLevel !== undefined || body.level !== undefined, {
        error: 'pmdLevel (or level) is required',
        path: ['pmdLevel'],
    })
    .refine(
        body =>
            body.pmdLevel === undefined || body.level === undefined || body.pmdLevel === body.level,
        {
            error: 'pmdLevel and level disagree',
            path: ['level'],
        },
    )
    .transform(body => ({
        twitchId: body.twitchId,
        pmdRegisterId: body.pmdRegisterId ?? null,
        pmdLevel: (body.pmdLevel ?? body.level) as number,
        nonce: body.nonce,
        species: body.species ? { nameId: body.species.nameId } : null,
        moves: body.moves ?? null,
    }))
    .meta({
        id: 'BrobotReturnRequest',
        description: doc`
            Bring a Pokémon home from pmd-online. One of \`pmdLevel\` and
            \`level\` is required, and the two agree when both are sent.
        `,
    });
export type ReturnBody = z.infer<typeof returnBodySchema>;

// ── response schemas ────────────────────────────────────────────────────────

/** Field names are the contract (`BrobotPokemonSchema` in libs/pmd-shared/pmd-contracts): renaming one breaks api-time. */
export const BrobotTransferPokemon = z
    .strictObject({
        id: z.uuid(),
        nameId: z.string(),
        dexNum: z.int(),
        name: z.string(),
        level: z.int().meta({ description: "brobot's level, unbounded" }),
        shiny: z.boolean(),
        gender: z.string(),
        nature: z.string(),
        ability: z.string(),
        item: z.string(),
        moves: z.array(z.string()),
        types: z.array(z.string()),
        wins: z.int(),
        losses: z.int(),
        draws: z.int(),
        activeGame: BrobotActiveGame,
        pmdRegisterId: z.uuid().nullable(),
        levelAtDeparture: z.int().nullable(),
        createdDate: z.iso.datetime(),
    })
    .meta({
        id: 'BrobotTransferPokemon',
        description: 'One brobot Pokémon as the transfer API returns it (`TransferPokemon`).',
    });

export const BrobotTransferPokemonList = z
    .strictObject({ pokemon: z.array(BrobotTransferPokemon).meta({ description: 'Oldest first' }) })
    .meta({ id: 'BrobotTransferPokemonList', description: "A user's Pokémon, every game." });

export const BrobotTransferPokemonResponse = z
    .strictObject({ pokemon: BrobotTransferPokemon })
    .meta({
        id: 'BrobotTransferPokemonResponse',
        description: 'The Pokémon after the transition.',
    });

// ── routes ──────────────────────────────────────────────────────────────────

const transferSecurity = requires('serviceToken');

const transition = {
    200: {
        description: 'Done, or the same nonce again: the same answer',
        body: BrobotTransferPokemonResponse,
    },
    400: validationFailed,
    401: unauthorized,
    403: {
        description: '`pokemon_not_owned`: the Pokémon belongs to another Twitch user',
        body: BrobotTransferError,
    },
    404: { description: '`pokemon_not_found`', body: BrobotTransferError },
    409: {
        description: 'Refused by the state machine; `code` says why',
        body: BrobotTransferError,
    },
} as const;

export const listUserTransferPokemon = defineRoute({
    operationId: 'listUserTransferPokemon',
    method: 'get',
    path: '/internal/transfer/users/{twitchId}/pokemon',
    tags: ['Transfer'],
    security: transferSecurity,
    summary: "A user's Pokémon",
    description: "The path api-time's client calls (pmd-contracts).",
    params: z.object({ twitchId: twitchIdSchema }),
    responses: {
        200: { description: 'Every Pokémon the user has', body: BrobotTransferPokemonList },
        400: validationFailed,
        401: unauthorized,
    },
});

export const listTransferPokemon = defineRoute({
    operationId: 'listTransferPokemon',
    method: 'get',
    path: '/internal/transfer/pokemon',
    tags: ['Transfer'],
    security: transferSecurity,
    summary: "A user's Pokémon (query form)",
    description: 'The same answer as `/internal/transfer/users/{twitchId}/pokemon`.',
    query: twitchIdQuerySchema,
    responses: {
        200: { description: 'Every Pokémon the user has', body: BrobotTransferPokemonList },
        400: validationFailed,
        401: unauthorized,
    },
});

export const departPokemon = defineRoute({
    operationId: 'departPokemon',
    method: 'post',
    path: '/internal/transfer/pokemon/{id}/depart',
    tags: ['Transfer'],
    security: transferSecurity,
    summary: 'Send a Pokémon to pmd-online',
    description: doc`
        It leaves its team slot: an away Pokémon holds none. Already in
        pmd-online under the same \`pmdRegisterId\` is a 200 with no write;
        under another, \`pokemon_away\` (409).
    `,
    params: z.object({ id: pokemonIdParamSchema }),
    body: departBodySchema,
    responses: transition,
});

export const returnPokemon = defineRoute({
    operationId: 'returnPokemon',
    method: 'post',
    path: '/internal/transfer/pokemon/{id}/return',
    tags: ['Transfer'],
    security: transferSecurity,
    summary: 'Bring a Pokémon home from pmd-online',
    description:
        'It comes home into the lowest free slot of its team; `team_full` (409) when there is none.',
    params: z.object({ id: pokemonIdParamSchema }),
    body: returnBodySchema,
    responses: transition,
});

export const transferRoutes = [
    listUserTransferPokemon,
    listTransferPokemon,
    departPokemon,
    returnPokemon,
] as const;
