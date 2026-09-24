import { decideDepart, decideReturn, levelOnReturn, TRANSFER_ERROR_CODES } from './transfer-rules';
import type { LoggedTransition, TransferState, TransitionHistory } from './transfer-rules';

const REGISTER = '11111111-1111-4111-8111-111111111111';
const OTHER_REGISTER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-24T12:00:00Z');

function home(overrides: Partial<TransferState> = {}): TransferState {
    return {
        active_game: 'brobot',
        level: 40,
        level_at_departure: null,
        pmd_register_id: null,
        pmd_first_transferred_at: null,
        ...overrides,
    };
}

function away(overrides: Partial<TransferState> = {}): TransferState {
    return home({
        active_game: 'pmd',
        level_at_departure: 40,
        pmd_register_id: REGISTER,
        pmd_first_transferred_at: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    });
}

const NO_HISTORY: TransitionHistory = { sameNonce: null, last: null };

function logged(
    id: number,
    direction: LoggedTransition['direction'],
    nonce: string,
): LoggedTransition {
    return { id, direction, nonce };
}

describe('decideDepart (brobot → PMD)', () => {
    it('moves a Pokémon that is in brobot, recording its level and the register row', () => {
        expect(
            decideDepart(home(), { pmdRegisterId: REGISTER, nonce: 'n1' }, NO_HISTORY, NOW),
        ).toEqual({
            kind: 'move',
            changes: {
                active_game: 'pmd',
                level_at_departure: 40,
                pmd_register_id: REGISTER,
                pmd_first_transferred_at: NOW,
            },
            levelBefore: 40,
            levelAfter: 40,
        });
    });

    it('keeps the first transfer time on every later trip', () => {
        const first = new Date('2025-05-05T05:05:05Z');
        const decision = decideDepart(
            home({
                level: 70,
                pmd_register_id: REGISTER,
                pmd_first_transferred_at: first,
                level_at_departure: 60,
            }),
            { pmdRegisterId: REGISTER, nonce: 'n3' },
            { sameNonce: null, last: logged(2, 'return', 'n2') },
            NOW,
        );
        expect(decision).toMatchObject({
            kind: 'move',
            changes: { pmd_first_transferred_at: first, level_at_departure: 70 },
        });
    });

    it('replays a repeated nonce: same answer, nothing written', () => {
        const entry = logged(1, 'depart', 'n1');
        expect(
            decideDepart(
                away(),
                { pmdRegisterId: REGISTER, nonce: 'n1' },
                { sameNonce: entry, last: entry },
                NOW,
            ),
        ).toEqual({ kind: 'unchanged', reason: 'replay' });
    });

    it('refuses a different nonce while the Pokémon is away under another register row (409 pokemon_away)', () => {
        expect(
            decideDepart(
                away(),
                { pmdRegisterId: OTHER_REGISTER, nonce: 'n9' },
                { sameNonce: null, last: logged(1, 'depart', 'n1') },
                NOW,
            ),
        ).toMatchObject({ kind: 'refuse', code: TRANSFER_ERROR_CODES.away });
    });

    it('answers a different nonce under the SAME register row with the row unchanged (api-time rolled back after brobot committed)', () => {
        expect(
            decideDepart(
                away(),
                { pmdRegisterId: REGISTER, nonce: 'n9' },
                { sameNonce: null, last: logged(1, 'depart', 'n1') },
                NOW,
            ),
        ).toEqual({ kind: 'unchanged', reason: 'already-there' });
    });

    it('refuses a nonce from an earlier trip instead of replaying it', () => {
        expect(
            decideDepart(
                home({ pmd_register_id: REGISTER, level_at_departure: 40 }),
                { pmdRegisterId: REGISTER, nonce: 'n1' },
                { sameNonce: logged(1, 'depart', 'n1'), last: logged(2, 'return', 'n2') },
                NOW,
            ),
        ).toMatchObject({ kind: 'refuse', code: TRANSFER_ERROR_CODES.nonceReused });
    });

    it('refuses a repeated nonce that names a different register row', () => {
        const entry = logged(1, 'depart', 'n1');
        expect(
            decideDepart(
                away(),
                { pmdRegisterId: OTHER_REGISTER, nonce: 'n1' },
                { sameNonce: entry, last: entry },
                NOW,
            ),
        ).toMatchObject({ kind: 'refuse', code: TRANSFER_ERROR_CODES.nonceReused });
    });
});

describe('levelOnReturn — levels carry, never regress (plan §4)', () => {
    it.each([
        [
            'a 150 that visited PMD as 100 returns as 150',
            { level: 150, level_at_departure: 150 },
            100,
            150,
        ],
        ['a 40 that PMD raised to 55 returns as 55', { level: 40, level_at_departure: 40 }, 55, 55],
        [
            'a 40 that PMD reports lower returns as 40',
            { level: 40, level_at_departure: 40 },
            30,
            40,
        ],
        [
            'with no departure level, brobot level is the floor',
            { level: 40, level_at_departure: null },
            12,
            40,
        ],
        [
            'a row edited down while away still returns at its departure level',
            { level: 20, level_at_departure: 60 },
            50,
            60,
        ],
    ])('%s', (_label, state, pmdLevel, expected) => {
        expect(levelOnReturn(state, pmdLevel)).toBe(expected);
    });

    it('is never below any of its inputs', () => {
        for (let level = 1; level <= 160; level += 7) {
            for (const departure of [null, 1, level, level + 5]) {
                for (let pmd = 1; pmd <= 100; pmd += 9) {
                    const result = levelOnReturn({ level, level_at_departure: departure }, pmd);
                    expect(result).toBeGreaterThanOrEqual(level);
                    expect(result).toBeGreaterThanOrEqual(departure ?? 0);
                    expect(result).toBeGreaterThanOrEqual(pmd);
                }
            }
        }
    });
});

describe('decideReturn (PMD → brobot)', () => {
    const history: TransitionHistory = { sameNonce: null, last: logged(1, 'depart', 'n1') };

    it('brings an away Pokémon home at the higher level', () => {
        expect(
            decideReturn(away(), { pmdRegisterId: REGISTER, pmdLevel: 55, nonce: 'n2' }, history),
        ).toEqual({
            kind: 'move',
            changes: { active_game: 'brobot', level: 55 },
            levelBefore: 40,
            levelAfter: 55,
        });
    });

    it('accepts the ticket shape without a register id', () => {
        expect(
            decideReturn(
                away({ level: 150, level_at_departure: 150 }),
                { pmdRegisterId: null, pmdLevel: 100, nonce: 'n2' },
                history,
            ),
        ).toMatchObject({
            kind: 'move',
            changes: { active_game: 'brobot', level: 150 },
        });
    });

    it('refuses a register row other than the one it left as (409 register_mismatch)', () => {
        expect(
            decideReturn(
                away(),
                { pmdRegisterId: OTHER_REGISTER, pmdLevel: 55, nonce: 'n2' },
                history,
            ),
        ).toMatchObject({ kind: 'refuse', code: TRANSFER_ERROR_CODES.registerMismatch });
    });

    it('replays a repeated nonce', () => {
        const entry = logged(2, 'return', 'n2');
        expect(
            decideReturn(
                home({ level: 55, pmd_register_id: REGISTER, level_at_departure: 40 }),
                { pmdRegisterId: REGISTER, pmdLevel: 55, nonce: 'n2' },
                { sameNonce: entry, last: entry },
            ),
        ).toEqual({ kind: 'unchanged', reason: 'replay' });
    });

    it('refuses a return nonce from an earlier trip once the Pokémon has left again', () => {
        expect(
            decideReturn(
                away(),
                { pmdRegisterId: REGISTER, pmdLevel: 90, nonce: 'n2' },
                { sameNonce: logged(2, 'return', 'n2'), last: logged(3, 'depart', 'n3') },
            ),
        ).toMatchObject({ kind: 'refuse', code: TRANSFER_ERROR_CODES.nonceReused });
    });

    it('answers a new nonce for a Pokémon already home under the named register row with the row unchanged', () => {
        expect(
            decideReturn(
                home({ level: 55, pmd_register_id: REGISTER }),
                { pmdRegisterId: REGISTER, pmdLevel: 99, nonce: 'n7' },
                { sameNonce: null, last: logged(2, 'return', 'n2') },
            ),
        ).toEqual({ kind: 'unchanged', reason: 'already-there' });
    });

    it.each([
        ['has never left', home(), REGISTER],
        ['is home and no register row is named', home({ pmd_register_id: REGISTER }), null],
        [
            'is home and another register row is named',
            home({ pmd_register_id: REGISTER }),
            OTHER_REGISTER,
        ],
    ])(
        'refuses a Pokémon that %s (409 pokemon_not_away) — it never gains levels while home',
        (_label, state, register) => {
            expect(
                decideReturn(
                    state,
                    { pmdRegisterId: register, pmdLevel: 100, nonce: 'n5' },
                    NO_HISTORY,
                ),
            ).toMatchObject({
                kind: 'refuse',
                code: TRANSFER_ERROR_CODES.notAway,
            });
        },
    );
});
