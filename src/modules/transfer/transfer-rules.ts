import type { ActiveGame, Pokemon } from '../../entities/pokemon.entity';
import type { TransferDirection } from './entities/transfer-log.entity';

/**
 * The `active_game` state machine behind `/api/internal/transfer` (migration
 * plan §4), as pure functions: the service loads the row under a lock, asks
 * here what to do, and writes the answer. Nothing in this file touches the
 * database, so every rule is unit-tested directly.
 */

/** PMD's level ceiling. A `return` never carries more (brobot's own levels are unbounded). */
export const PMD_LEVEL_CAP = 100;

/**
 * The `code` of every keyed refusal, sent as `{ statusCode, error, code,
 * message }`. api-time maps 403/404 to "not found" and any 409 to
 * `brobot_refused` with the message, so the codes are for logs and humans.
 */
export const TRANSFER_ERROR_CODES = {
    /** 404 — no Pokémon with that id. */
    notFound: 'pokemon_not_found',
    /** 403 — the Pokémon belongs to a different Twitch user. */
    notOwned: 'pokemon_not_owned',
    /** 409 — depart: already in PMD under a different register row. */
    away: 'pokemon_away',
    /** 409 — return: already in brobot, and not under the register row given. */
    notAway: 'pokemon_not_away',
    /** 409 — return: in PMD, but under a different register row than the one returning it. */
    registerMismatch: 'register_mismatch',
    /** 409 — the nonce belongs to an earlier transition, not the Pokémon's last one. */
    nonceReused: 'nonce_reused',
} as const;
export type TransferErrorCode = (typeof TRANSFER_ERROR_CODES)[keyof typeof TRANSFER_ERROR_CODES];

/** The columns the state machine reads. */
export type TransferState = Pick<
    Pokemon,
    'active_game' | 'level' | 'level_at_departure' | 'pmd_register_id' | 'pmd_first_transferred_at'
>;

/** A `transfer_log` row, as far as the rules care. */
export interface LoggedTransition {
    id: number;
    direction: TransferDirection;
    nonce: string;
}

export interface TransitionHistory {
    /** The log row with this request's `(direction, nonce)`, if any. */
    sameNonce: LoggedTransition | null;
    /** The Pokémon's latest log row, if any. */
    last: LoggedTransition | null;
}

export type TransferDecision =
    | {
          kind: 'move';
          changes: Partial<TransferState> & { active_game: ActiveGame };
          levelBefore: number;
          levelAfter: number;
      }
    /** Nothing to write; answer 200 with the row as it stands (a replay, or already there). */
    | { kind: 'unchanged'; reason: 'replay' | 'already-there' }
    | { kind: 'refuse'; code: TransferErrorCode; message: string };

export interface DepartRequest {
    pmdRegisterId: string;
    nonce: string;
}

export interface ReturnRequest {
    /** Optional: api-time sends it, the ticket's shape does not. Checked when present. */
    pmdRegisterId: string | null;
    pmdLevel: number;
    nonce: string;
}

/**
 * A nonce already in the log replays only if its transition is the
 * Pokémon's last one and the row still stands where it put it. A nonce from
 * an earlier trip is refused: replaying it would answer "departed" about a
 * Pokémon that has since come home.
 */
function replayOf(
    state: TransferState,
    history: TransitionHistory,
    landedIn: ActiveGame,
    registerMatches: boolean,
): TransferDecision | null {
    const { sameNonce, last } = history;
    if (!sameNonce) return null;
    if (last?.id === sameNonce.id && state.active_game === landedIn && registerMatches) {
        return { kind: 'unchanged', reason: 'replay' };
    }
    return {
        kind: 'refuse',
        code: TRANSFER_ERROR_CODES.nonceReused,
        message: 'that nonce was already used for an earlier transfer of this Pokémon',
    };
}

/**
 * brobot → PMD. Moves only from `brobot`. Already in PMD under the same
 * register row is a 200 without a write (api-time re-sends with a fresh nonce
 * when its own half rolled back after brobot committed); under any other
 * register row it is `pokemon_away`.
 */
export function decideDepart(
    state: TransferState,
    request: DepartRequest,
    history: TransitionHistory,
    now: Date,
): TransferDecision {
    const replay = replayOf(state, history, 'pmd', state.pmd_register_id === request.pmdRegisterId);
    if (replay) return replay;

    if (state.active_game === 'pmd') {
        if (state.pmd_register_id === request.pmdRegisterId)
            return { kind: 'unchanged', reason: 'already-there' };
        return {
            kind: 'refuse',
            code: TRANSFER_ERROR_CODES.away,
            message: 'this Pokémon is already away in PMD',
        };
    }

    return {
        kind: 'move',
        changes: {
            active_game: 'pmd',
            level_at_departure: state.level,
            pmd_register_id: request.pmdRegisterId,
            pmd_first_transferred_at: state.pmd_first_transferred_at ?? now,
        },
        levelBefore: state.level,
        levelAfter: state.level,
    };
}

/**
 * The level a Pokémon comes home at. Levels carry and never regress (plan
 * §4): PMD's level counts only when it is higher than what brobot had when it
 * left — a 150 that visited as 100 returns as 150, a 40 that PMD raised to 55
 * returns as 55. `level` is in the max too, so a row edited while away can
 * never lose levels either.
 */
export function levelOnReturn(
    state: Pick<TransferState, 'level' | 'level_at_departure'>,
    pmdLevel: number,
): number {
    return Math.max(state.level, state.level_at_departure ?? state.level, pmdLevel);
}

/**
 * PMD → brobot. Moves only from `pmd`, and only under the register row it
 * left as (when the caller names one). Already home under that register row
 * is a 200 without a write.
 */
export function decideReturn(
    state: TransferState,
    request: ReturnRequest,
    history: TransitionHistory,
): TransferDecision {
    const registerMatches =
        request.pmdRegisterId === null || request.pmdRegisterId === state.pmd_register_id;
    const replay = replayOf(state, history, 'brobot', registerMatches);
    if (replay) return replay;

    if (state.active_game === 'brobot') {
        if (request.pmdRegisterId !== null && request.pmdRegisterId === state.pmd_register_id) {
            return { kind: 'unchanged', reason: 'already-there' };
        }
        return {
            kind: 'refuse',
            code: TRANSFER_ERROR_CODES.notAway,
            message: 'this Pokémon is not away in PMD',
        };
    }

    if (!registerMatches) {
        return {
            kind: 'refuse',
            code: TRANSFER_ERROR_CODES.registerMismatch,
            message: 'this Pokémon is in PMD under a different register row',
        };
    }

    const level = levelOnReturn(state, request.pmdLevel);
    return {
        kind: 'move',
        changes: { active_game: 'brobot', level },
        levelBefore: state.level,
        levelAfter: level,
    };
}
