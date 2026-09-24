import { z } from 'zod';
import { PMD_LEVEL_CAP } from './transfer-rules';

/**
 * Request shapes of `/api/internal/transfer`. The authoritative copy of the
 * contract is `libs/pmd-contracts/src/transfer.ts` in the superproject
 * (ticket A1); these accept everything it sends, plus the ticket-B3 spelling
 * of the return body (`pmdLevel` for `level`, no `pmdRegisterId`).
 */

/** Twitch user ids are numeric strings (brobot's `twitch_user.oauth_id`). */
export const twitchIdSchema = z
    .string()
    .trim()
    .regex(/^\d{1,32}$/, 'must be a Twitch user id');

/** The caller's idempotency key. api-time sends a uuid; any short token is accepted. */
const nonceSchema = z.string().trim().min(1).max(128);

const pmdLevelSchema = z.number().int().min(1).max(PMD_LEVEL_CAP);

export const pokemonIdParamSchema = z.string().uuid('must be a brobot Pokémon id');

export const twitchIdQuerySchema = z.object({ twitchId: twitchIdSchema });

export const departBodySchema = z.object({
    twitchId: twitchIdSchema,
    pmdRegisterId: z.string().uuid(),
    nonce: nonceSchema,
});
export type DepartBody = z.infer<typeof departBodySchema>;

export const returnBodySchema = z
    .object({
        twitchId: twitchIdSchema,
        /** api-time (A1) sends the register row it is returning from; checked against the row when present. */
        pmdRegisterId: z.string().uuid().optional(),
        /** PMD's level for it. `level` is the pmd-contracts spelling, `pmdLevel` the ticket's; send one. */
        pmdLevel: pmdLevelSchema.optional(),
        level: pmdLevelSchema.optional(),
        nonce: nonceSchema,
    })
    .refine(body => body.pmdLevel !== undefined || body.level !== undefined, {
        message: 'pmdLevel (or level) is required',
        path: ['pmdLevel'],
    })
    .refine(
        body =>
            body.pmdLevel === undefined || body.level === undefined || body.pmdLevel === body.level,
        {
            message: 'pmdLevel and level disagree',
            path: ['level'],
        },
    )
    .transform(body => ({
        twitchId: body.twitchId,
        pmdRegisterId: body.pmdRegisterId ?? null,
        pmdLevel: (body.pmdLevel ?? body.level) as number,
        nonce: body.nonce,
    }));
export type ReturnBody = z.infer<typeof returnBodySchema>;
