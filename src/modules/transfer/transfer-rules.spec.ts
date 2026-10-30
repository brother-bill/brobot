import { decideDepart, decideReturn, levelOnReturn, TRANSFER_ERROR_CODES } from './transfer-rules';
import type { LoggedTransition, TeamSlots, TransferState, TransitionHistory } from './transfer-rules';

const REGISTER = '11111111-1111-4111-8111-111111111111';
const OTHER_REGISTER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-24T12:00:00Z');

function home(overrides: Partial<TransferState> = {}): TransferState {
    return {
        active_game: 'brobot',
        name_id: 'pikachu',
        level: 40,
        level_at_departure: null,
        pmd_register_id: null,
        pmd_first_transferred_at: null,
        slot: 1,
        ...overrides,
    };
}

function away(overrides: Partial<TransferState> = {}): TransferState {
    return home({
        active_game: 'pmd',
        level_at_departure: 40,
        pmd_register_id: REGISTER,
        pmd_first_transferred_at: new Date('2026-01-01T00:00:00Z'),
        slot: null,
        ...overrides,
    });
}

/** The owner's team while the Pokémon is away: slot 1 is free, as it is once a starter leaves. */
const TEAM: TeamSlots = [{ slot: 2 }, { slot: 3 }];
const FULL_TEAM: TeamSlots = [1, 2, 3, 4, 5, 6].map(slot => ({ slot }));

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
                slot: null,
                level_at_departure: 40,
                pmd_register_id: REGISTER,
                pmd_first_transferred_at: NOW,
            },
            levelBefore: 40,
            levelAfter: 40,
        });
    });

    it('gives up its slot, slot 1 included, so the viewer keeps a usable team', () => {
        const decision = decideDepart(home({ slot: 1 }), { pmdRegisterId: REGISTER, nonce: 'n1' }, NO_HISTORY, NOW);
        expect(decision).toMatchObject({ kind: 'move', changes: { active_game: 'pmd', slot: null } });
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
            decideReturn(away(), { pmdRegisterId: REGISTER, pmdLevel: 55, nonce: 'n2' }, history, TEAM),
        ).toEqual({
            kind: 'move',
            changes: { active_game: 'brobot', level: 55, slot: 1 },
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
                TEAM,
            ),
        ).toMatchObject({
            kind: 'move',
            changes: { active_game: 'brobot', level: 150, slot: 1 },
        });
    });

    it('refuses a register row other than the one it left as (409 register_mismatch)', () => {
        expect(
            decideReturn(
                away(),
                { pmdRegisterId: OTHER_REGISTER, pmdLevel: 55, nonce: 'n2' },
                history,
                TEAM,
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
                TEAM,
            ),
        ).toEqual({ kind: 'unchanged', reason: 'replay' });
    });

    it('refuses a return nonce from an earlier trip once the Pokémon has left again', () => {
        expect(
            decideReturn(
                away(),
                { pmdRegisterId: REGISTER, pmdLevel: 90, nonce: 'n2' },
                { sameNonce: logged(2, 'return', 'n2'), last: logged(3, 'depart', 'n3') },
                TEAM,
            ),
        ).toMatchObject({ kind: 'refuse', code: TRANSFER_ERROR_CODES.nonceReused });
    });

    it('answers a new nonce for a Pokémon already home under the named register row with the row unchanged', () => {
        expect(
            decideReturn(
                home({ level: 55, pmd_register_id: REGISTER }),
                { pmdRegisterId: REGISTER, pmdLevel: 99, nonce: 'n7' },
                { sameNonce: null, last: logged(2, 'return', 'n2') },
                TEAM,
            ),
        ).toEqual({ kind: 'unchanged', reason: 'already-there' });
    });

    describe('what changed while it was away (owner requirement 5)', () => {
        const back = { pmdRegisterId: REGISTER, pmdLevel: 55, nonce: 'n2' };

        it('writes only the transfer columns when the request carries no species or moves', () => {
            const decision = decideReturn(away(), back, history, TEAM);
            expect(decision).toEqual(
                decideReturn(away(), { ...back, species: null, moves: null }, history, TEAM),
            );
            expect(decision).toMatchObject({ kind: 'move' });
            if (decision.kind === 'move') {
                expect(Object.keys(decision.changes).sort()).toEqual(['active_game', 'level', 'slot']);
            }
        });

        it('applies a forward evolution and a new moveset together with the level', () => {
            expect(
                decideReturn(
                    away(),
                    { ...back, species: { nameId: 'raichu' }, moves: ['thunder', 'irontail'] },
                    history,
                    TEAM,
                ),
            ).toEqual({
                kind: 'move',
                changes: {
                    active_game: 'brobot',
                    level: 55,
                    slot: 1,
                    name: 'Raichu',
                    name_id: 'raichu',
                    dex_num: 26,
                    types: ['Electric'],
                    color: 'Yellow',
                    moves: ['thunder', 'irontail'],
                },
                levelBefore: 40,
                levelAfter: 55,
            });
        });

        it('leaves the species columns alone when the species sent is the row’s own', () => {
            const decision = decideReturn(
                away(),
                { ...back, species: { nameId: 'pikachu' } },
                history,
                TEAM,
            );
            expect(decision).toEqual({
                kind: 'move',
                changes: { active_game: 'brobot', level: 55, slot: 1 },
                levelBefore: 40,
                levelAfter: 55,
            });
        });

        it('refuses anything but a forward evolution (409 not_forward_evolution)', () => {
            expect(
                decideReturn(away(), { ...back, species: { nameId: 'pichu' } }, history, TEAM),
            ).toMatchObject({ kind: 'refuse', code: TRANSFER_ERROR_CODES.notForwardEvolution });
        });

        it('refuses a moveset with a move @pkmn does not know (409 unknown_move)', () => {
            expect(
                decideReturn(away(), { ...back, moves: ['thunderbolt', 'notamove'] }, history, TEAM),
            ).toMatchObject({
                kind: 'refuse',
                code: TRANSFER_ERROR_CODES.unknownMove,
                message: 'unknown move notamove',
            });
        });

        it('applies nothing again on a replay, though the row has already evolved', () => {
            const entry = logged(2, 'return', 'n2');
            expect(
                decideReturn(
                    home({ name_id: 'raichu', level: 55, pmd_register_id: REGISTER }),
                    { ...back, species: { nameId: 'raichu' }, moves: ['thunder'] },
                    { sameNonce: entry, last: entry },
                    TEAM,
                ),
            ).toEqual({ kind: 'unchanged', reason: 'replay' });
        });

        it('applies nothing to a Pokémon already home under the named register row', () => {
            expect(
                decideReturn(
                    home({ name_id: 'raichu', level: 55, pmd_register_id: REGISTER }),
                    { ...back, nonce: 'n3', species: { nameId: 'raichu' }, moves: ['thunder'] },
                    { sameNonce: null, last: logged(2, 'return', 'n2') },
                    TEAM,
                ),
            ).toEqual({ kind: 'unchanged', reason: 'already-there' });
        });
    });

    describe('the slot it comes home to (an away Pokémon holds none)', () => {
        const back = { pmdRegisterId: REGISTER, pmdLevel: 55, nonce: 'n2' };

        it('takes slot 1 when it is free', () => {
            expect(decideReturn(away(), back, history, TEAM)).toMatchObject({
                kind: 'move',
                changes: { slot: 1 },
            });
            expect(decideReturn(away(), back, history, [])).toMatchObject({
                kind: 'move',
                changes: { slot: 1 },
            });
        });

        it('otherwise takes the lowest free slot', () => {
            expect(
                decideReturn(away(), back, history, [{ slot: 1 }, { slot: 2 }, { slot: 4 }]),
            ).toMatchObject({ kind: 'move', changes: { slot: 3 } });
            expect(
                decideReturn(away(), back, history, FULL_TEAM.filter(member => member.slot !== 6)),
            ).toMatchObject({ kind: 'move', changes: { slot: 6 } });
        });

        it('ignores team members that hold no slot (others away in PMD)', () => {
            expect(
                decideReturn(away(), back, history, [{ slot: null }, { slot: 1 }, { slot: null }]),
            ).toMatchObject({ kind: 'move', changes: { slot: 2 } });
        });

        it('keeps the slot of a Pokémon that left before the slot rule', () => {
            expect(decideReturn(away({ slot: 4 }), back, history, FULL_TEAM)).toMatchObject({
                kind: 'move',
                changes: { slot: 4 },
            });
        });

        it('refuses when all six slots are taken (409 team_full), writing nothing', () => {
            expect(decideReturn(away(), back, history, FULL_TEAM)).toEqual({
                kind: 'refuse',
                code: TRANSFER_ERROR_CODES.teamFull,
                message: 'your brobot team is full: free a slot with !pokemon delete <n> first',
            });
        });

        it('still replays a repeated nonce when the team has since filled up', () => {
            const entry = logged(2, 'return', 'n2');
            expect(
                decideReturn(
                    home({ level: 55, pmd_register_id: REGISTER, level_at_departure: 40 }),
                    back,
                    { sameNonce: entry, last: entry },
                    FULL_TEAM,
                ),
            ).toEqual({ kind: 'unchanged', reason: 'replay' });
        });
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
                    TEAM,
                ),
            ).toMatchObject({
                kind: 'refuse',
                code: TRANSFER_ERROR_CODES.notAway,
            });
        },
    );
});
