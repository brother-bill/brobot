import type { OldTable, RawRow } from './old-schema';
import { parsePgArray } from './pg-text';

/**
 * One mapper per old Prisma table: an old row (every value as Postgres
 * text, see `RawRow`) → the new entity's data, keyed by the entity's
 * property names (which are also its column names). Relations are given by
 * primary key. Pure and synchronous; a row that cannot be represented in the
 * new schema throws `RowMappingError` naming the column and the reason.
 */

export class RowMappingError extends Error {
    override name = 'RowMappingError';

    constructor(readonly column: string, readonly reason: string) {
        super(`${column}: ${reason}`);
    }
}

// ── column readers ─────────────────────────────────────────────────────────

function present(row: RawRow, column: string): string {
    const value = row[column];
    if (value === undefined) throw new RowMappingError(column, 'column missing from the row');
    if (value === null) throw new RowMappingError(column, 'is NULL but the new column is NOT NULL');
    return value;
}

function text(row: RawRow, column: string): string {
    return present(row, column);
}

function nonEmptyText(row: RawRow, column: string): string {
    const value = present(row, column);
    if (value.trim() === '') throw new RowMappingError(column, 'is empty');
    return value;
}

function nullableText(row: RawRow, column: string): string | null {
    const value = row[column];
    if (value === undefined) throw new RowMappingError(column, 'column missing from the row');
    return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The old ids are `text` holding Prisma `uuid()` values; the new columns are `uuid`. */
function uuid(row: RawRow, column: string): string {
    const value = present(row, column).trim();
    if (!UUID.test(value))
        throw new RowMappingError(column, `${JSON.stringify(value)} is not a uuid`);
    return value.toLowerCase();
}

function nullableUuid(row: RawRow, column: string): string | null {
    return nullableText(row, column) === null ? null : uuid(row, column);
}

function integer(
    row: RawRow,
    column: string,
    { min, max = 2_147_483_647 }: { min: number; max?: number },
): number {
    const value = present(row, column).trim();
    if (!/^-?\d+$/.test(value))
        throw new RowMappingError(column, `${JSON.stringify(value)} is not an integer`);
    const parsed = Number(value);
    if (parsed < min || parsed > max)
        throw new RowMappingError(column, `${parsed} is outside ${min}..${max}`);
    return parsed;
}

/** `bigint` → JS number (the entity's `BigIntType('number')`); refuses what a double cannot hold exactly. */
function bigint(row: RawRow, column: string): number {
    const value = present(row, column).trim();
    if (!/^-?\d+$/.test(value))
        throw new RowMappingError(column, `${JSON.stringify(value)} is not an integer`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed))
        throw new RowMappingError(column, `${value} does not fit a JS number exactly`);
    return parsed;
}

function boolean(row: RawRow, column: string): boolean {
    const value = present(row, column).trim().toLowerCase();
    if (value === 't' || value === 'true') return true;
    if (value === 'f' || value === 'false') return false;
    throw new RowMappingError(column, `${JSON.stringify(value)} is not a boolean`);
}

const TIMESTAMP =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** `+02`, `+0200` or `+02:00` → `+02:00`. */
function isoOffset(zone: string): string {
    return `${zone.slice(0, 3)}:${zone.slice(3).replace(':', '') || '00'}`;
}

/**
 * Prisma's `TIMESTAMP(3)` has no zone and Prisma wrote UTC into it, so a bare
 * `2022-11-30 13:06:40.123` is read as UTC. An explicit offset is honoured.
 */
function timestamp(row: RawRow, column: string): Date {
    const value = present(row, column).trim();
    const match = TIMESTAMP.exec(value);
    if (!match) throw new RowMappingError(column, `${JSON.stringify(value)} is not a timestamp`);
    const [, date, time] = match;
    // An optional group is undefined when it did not match; the tuple type does not say so.
    const zone = match[3] as string | undefined;
    const offset = zone === undefined || zone === 'Z' ? 'Z' : isoOffset(zone);
    const parsed = new Date(`${date}T${time.slice(0, 12)}${offset}`);
    if (Number.isNaN(parsed.getTime()))
        throw new RowMappingError(column, `${JSON.stringify(value)} is not a valid date`);
    return parsed;
}

/**
 * Prisma's `String[]` was a nullable `text[]`; the new columns are NOT NULL.
 * NULL becomes `fallback` (`{}` unless the column has another default); a
 * NULL element cannot be kept and fails the row.
 */
function textArray(row: RawRow, column: string, fallback: string[] = []): string[] {
    const value = nullableText(row, column);
    if (value === null) return [...fallback];
    let elements: (string | null)[];
    try {
        elements = parsePgArray(value);
    } catch (error) {
        throw new RowMappingError(column, error instanceof Error ? error.message : String(error));
    }
    if (elements.some(element => element === null))
        throw new RowMappingError(column, 'contains a NULL element');
    return elements as string[];
}

// ── the mapped shapes ──────────────────────────────────────────────────────

export interface TwitchUserData {
    oauth_id: string;
    display_name: string;
    created_date: Date;
    roles: string[];
    updated_date: Date;
}

export interface TwitchUserRegisteredData {
    id: string;
    twitch_user: string;
    email: string | null;
    profile_image_url: string;
    scope: string[];
    updated_date: Date;
    origin_date: Date;
    registered_date: Date;
}

export interface TwitchTokenData {
    id: string;
    access_token: string;
    refresh_token: string;
    scope: string[];
    created_date: Date;
    expiry_seconds: number;
    twitch_user: string;
    updated_date: Date;
    obtainment_epoch: number;
}

export interface PokemonTeamData {
    id: string;
    twitch_user: string;
    created_date: Date;
    updated_date: Date;
}

export interface PokemonData {
    id: string;
    name: string;
    name_id: string;
    slot: number;
    level: number;
    shiny: boolean;
    wins: number;
    losses: number;
    draws: number;
    item: string;
    moves: string[];
    dex_num: number;
    color: string;
    types: string[];
    gender: string;
    nature: string;
    ability: string;
    team: string | null;
    twitch_user: string;
    created_date: Date;
    updated_date: Date;
    /** Every imported Pokémon starts at home; the other three transfer columns stay NULL. */
    active_game: 'brobot';
}

export interface BattleOutcomeData {
    id: string;
    updated_date: Date;
    outcome: string[];
}

// ── the mappers ────────────────────────────────────────────────────────────

/** `TwitchUser` → `twitch_user`. The Twitch id stays the key; `roles` is kept verbatim. */
export function mapTwitchUser(row: RawRow): TwitchUserData {
    return {
        oauth_id: nonEmptyText(row, 'oauthId'),
        display_name: text(row, 'displayName'),
        created_date: timestamp(row, 'createdDate'),
        // NULL only if something wrote it explicitly; the column's default then applies.
        roles: textArray(row, 'roles', ['Viewer']),
        updated_date: timestamp(row, 'updatedDate'),
    };
}

export function mapTwitchUserRegistered(row: RawRow): TwitchUserRegisteredData {
    return {
        id: uuid(row, 'id'),
        twitch_user: nonEmptyText(row, 'userOauthId'),
        email: nullableText(row, 'email'),
        profile_image_url: text(row, 'profileImageUrl'),
        scope: textArray(row, 'scope'),
        updated_date: timestamp(row, 'updatedDate'),
        origin_date: timestamp(row, 'originDate'),
        registered_date: timestamp(row, 'registeredDate'),
    };
}

/** `TwitchBotAuth` and `TwitchStreamerAuth` have the same columns. */
export function mapTwitchToken(row: RawRow): TwitchTokenData {
    return {
        id: uuid(row, 'id'),
        access_token: text(row, 'accessToken'),
        refresh_token: text(row, 'refreshToken'),
        scope: textArray(row, 'scope'),
        created_date: timestamp(row, 'createdDate'),
        expiry_seconds: integer(row, 'expirySeconds', { min: -2_147_483_648 }),
        twitch_user: nonEmptyText(row, 'userOauthId'),
        updated_date: timestamp(row, 'updatedDate'),
        obtainment_epoch: bigint(row, 'obtainmentEpoch'),
    };
}

export function mapPokemonTeam(row: RawRow): PokemonTeamData {
    return {
        id: uuid(row, 'id'),
        twitch_user: nonEmptyText(row, 'userOauthId'),
        created_date: timestamp(row, 'createdDate'),
        updated_date: timestamp(row, 'updatedDate'),
    };
}

const GENDERS = ['M', 'F', 'N'];

/**
 * `Pokemon` → `pokemon`, at home in brobot. Refuses what the new schema or
 * the transfer contract cannot carry: a slot outside 1..6 (the new check
 * constraint), a level below 1, negative counters, a gender other than
 * M/F/N (pmd-contracts' `BrobotPokemonSchema` would reject the whole list).
 */
export function mapPokemon(row: RawRow): PokemonData {
    const gender = text(row, 'gender');
    if (!GENDERS.includes(gender))
        throw new RowMappingError('gender', `${JSON.stringify(gender)} is not M, F or N`);
    return {
        id: uuid(row, 'id'),
        name: nonEmptyText(row, 'name'),
        name_id: nonEmptyText(row, 'nameId'),
        slot: integer(row, 'slot', { min: 1, max: 6 }),
        level: integer(row, 'level', { min: 1 }),
        shiny: boolean(row, 'shiny'),
        wins: integer(row, 'wins', { min: 0 }),
        losses: integer(row, 'losses', { min: 0 }),
        draws: integer(row, 'draws', { min: 0 }),
        item: text(row, 'item'),
        moves: textArray(row, 'moves'),
        dex_num: integer(row, 'dexNum', { min: 0 }),
        color: text(row, 'color'),
        types: textArray(row, 'types'),
        gender,
        nature: text(row, 'nature'),
        ability: text(row, 'ability'),
        team: nullableUuid(row, 'teamId'),
        twitch_user: nonEmptyText(row, 'userOauthId'),
        created_date: timestamp(row, 'createdDate'),
        updated_date: timestamp(row, 'updatedDate'),
        active_game: 'brobot',
    };
}

/** `PokemonBattleOutcome` and `PokemonTeamBattleOutcome` have the same columns. */
export function mapBattleOutcome(row: RawRow): BattleOutcomeData {
    return {
        id: uuid(row, 'id'),
        updated_date: timestamp(row, 'updatedDate'),
        outcome: textArray(row, 'outcome'),
    };
}

export interface MappedByTable {
    TwitchUser: TwitchUserData;
    TwitchUserRegistered: TwitchUserRegisteredData;
    TwitchBotAuth: TwitchTokenData;
    TwitchStreamerAuth: TwitchTokenData;
    PokemonTeam: PokemonTeamData;
    Pokemon: PokemonData;
    PokemonBattleOutcome: BattleOutcomeData;
    PokemonTeamBattleOutcome: BattleOutcomeData;
}

export const ROW_MAPPERS: { [T in OldTable]: (row: RawRow) => MappedByTable[T] } = {
    TwitchUser: mapTwitchUser,
    TwitchUserRegistered: mapTwitchUserRegistered,
    TwitchBotAuth: mapTwitchToken,
    TwitchStreamerAuth: mapTwitchToken,
    PokemonTeam: mapPokemonTeam,
    Pokemon: mapPokemon,
    PokemonBattleOutcome: mapBattleOutcome,
    PokemonTeamBattleOutcome: mapBattleOutcome,
};
