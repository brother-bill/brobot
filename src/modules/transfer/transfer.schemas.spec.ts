import type { z } from 'zod';
import { PMD_LEVEL_CAP } from './transfer-rules';
import { departBodySchema, pokemonIdParamSchema, returnBodySchema } from './transfer.schemas';

/**
 * The zod 4 spellings (`z.uuid()` for `z.string().uuid()`, `{ error }` for
 * `{ message }`) validate exactly as the zod 3 ones did: each rewritten schema
 * accepts its edge, refuses one past it, and refuses with the message it
 * always carried.
 */

const UUID = '3f2b8c1e-9a4d-4e6b-8c2f-1d7a5e9b0c34';
/** One past the edge: version nibble 0, below the 1-8 a uuid may carry. */
const NOT_UUID = '3f2b8c1e-9a4d-0e6b-8c2f-1d7a5e9b0c34';

/** The issues a refusal carries, as `path: message`; `[]` when the value parses. */
function issues(schema: z.ZodType, value: unknown): string[] {
    const result = schema.safeParse(value);
    return result.success
        ? []
        : result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
}

const depart = { twitchId: '4242', pmdRegisterId: UUID, nonce: 'n-1' };
const back = { twitchId: '4242', nonce: 'n-1' };

describe('transfer schemas keep their validation under the zod 4 spellings', () => {
    it('pokemonIdParamSchema takes a uuid and refuses anything else with its message', () => {
        expect(issues(pokemonIdParamSchema, UUID)).toEqual([]);
        expect(issues(pokemonIdParamSchema, NOT_UUID)).toEqual([': must be a brobot Pokémon id']);
        expect(issues(pokemonIdParamSchema, `${UUID}0`)).toEqual([': must be a brobot Pokémon id']);
    });

    it("departBodySchema's pmdRegisterId takes a uuid and refuses anything else", () => {
        expect(issues(departBodySchema, depart)).toEqual([]);
        expect(issues(departBodySchema, { ...depart, pmdRegisterId: NOT_UUID })).toEqual([
            'pmdRegisterId: Invalid UUID',
        ]);
    });

    it("returnBodySchema's optional pmdRegisterId takes a uuid or nothing, and refuses anything else", () => {
        expect(issues(returnBodySchema, { ...back, level: 1, pmdRegisterId: UUID })).toEqual([]);
        expect(issues(returnBodySchema, { ...back, level: 1 })).toEqual([]);
        expect(issues(returnBodySchema, { ...back, level: 1, pmdRegisterId: NOT_UUID })).toEqual([
            'pmdRegisterId: Invalid UUID',
        ]);
    });

    it('returnBodySchema requires pmdLevel or level, with its message', () => {
        expect(issues(returnBodySchema, { ...back, pmdLevel: PMD_LEVEL_CAP })).toEqual([]);
        expect(issues(returnBodySchema, { ...back, level: PMD_LEVEL_CAP })).toEqual([]);
        expect(issues(returnBodySchema, back)).toEqual([
            'pmdLevel: pmdLevel (or level) is required',
        ]);
    });

    it('returnBodySchema refuses a pmdLevel and level that disagree, with its message', () => {
        expect(issues(returnBodySchema, { ...back, pmdLevel: 40, level: 40 })).toEqual([]);
        expect(issues(returnBodySchema, { ...back, pmdLevel: 40, level: 41 })).toEqual([
            'level: pmdLevel and level disagree',
        ]);
    });
});
