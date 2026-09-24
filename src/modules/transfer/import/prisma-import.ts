import type { EntityClass, EntityData, EntityManager } from '@mikro-orm/core';
import {
    Pokemon,
    PokemonBattleOutcome,
    PokemonTeam,
    PokemonTeamBattleOutcome,
    TwitchBotAuth,
    TwitchStreamerAuth,
    TwitchUser,
    TwitchUserRegistered,
} from '../../../entities';
import { OLD_TABLE_NAMES } from './old-schema';
import type { OldTable, RawRow } from './old-schema';
import { ROW_MAPPERS, RowMappingError } from './prisma-row-mappers';
import type { MappedByTable } from './prisma-row-mappers';

/**
 * The Prisma → MikroORM data import behind `scripts/import-prisma-dump.ts`,
 * in two steps: `planImport` maps every old row and checks the references
 * between them (pure — this is the whole of `--dry-run`), `applyImport`
 * upserts the plan through MikroORM in one transaction.
 */

/** Where each old table lands, and what an upsert must never overwrite. */
const TARGETS: Record<
    OldTable,
    { table: string; entity: EntityClass<object>; key: string; keep?: string[] }
> = {
    TwitchUser: { table: 'twitch_user', entity: TwitchUser, key: 'oauth_id' },
    TwitchUserRegistered: {
        table: 'twitch_user_registered',
        entity: TwitchUserRegistered,
        key: 'id',
    },
    TwitchBotAuth: { table: 'twitch_bot_auth', entity: TwitchBotAuth, key: 'id' },
    TwitchStreamerAuth: { table: 'twitch_streamer_auth', entity: TwitchStreamerAuth, key: 'id' },
    PokemonTeam: { table: 'pokemon_team', entity: PokemonTeam, key: 'id' },
    Pokemon: {
        table: 'pokemon',
        entity: Pokemon,
        key: 'id',
        // Re-running the import must not bring home a Pokémon that is away in
        // PMD: the transfer columns belong to the transfer API, not the dump.
        keep: ['active_game', 'pmd_register_id', 'pmd_first_transferred_at', 'level_at_departure'],
    },
    PokemonBattleOutcome: {
        table: 'pokemon_battle_outcome',
        entity: PokemonBattleOutcome,
        key: 'id',
    },
    PokemonTeamBattleOutcome: {
        table: 'pokemon_team_battle_outcome',
        entity: PokemonTeamBattleOutcome,
        key: 'id',
    },
};

export function newTableFor(table: OldTable): string {
    return TARGETS[table].table;
}

export interface RowFailure {
    table: OldTable;
    /** 1-based position of the row within its table in the source. */
    row: number;
    /** The row's old primary key, when it had a readable one. */
    key: string | null;
    reason: string;
}

export interface TableReport {
    table: OldTable;
    newTable: string;
    read: number;
    mapped: number;
    failed: number;
}

export interface ImportPlan {
    rows: { [T in OldTable]: MappedByTable[T][] };
    report: TableReport[];
    failures: RowFailure[];
    warnings: string[];
    /** True when mapping stopped at the first failure (no `--continue`). */
    aborted: boolean;
}

export interface PlanOptions {
    /** Skip unmappable rows (and rows that depend on them) instead of stopping at the first. */
    continueOnFailure: boolean;
}

function emptyRows(): ImportPlan['rows'] {
    return Object.fromEntries(
        OLD_TABLE_NAMES.map(table => [table, []]),
    ) as unknown as ImportPlan['rows'];
}

function keyOf(row: RawRow): string | null {
    return row.id ?? row.oauthId ?? null;
}

/**
 * Map every old row, parents first, and check each reference points at a row
 * that is itself being imported — so a skipped user takes its team, tokens
 * and Pokémon with it, as failures, rather than as a foreign-key error half
 * way through the write.
 */
export function planImport(
    source: ReadonlyMap<OldTable, RawRow[]>,
    options: PlanOptions,
): ImportPlan {
    const plan: ImportPlan = {
        rows: emptyRows(),
        report: [],
        failures: [],
        warnings: [],
        aborted: false,
    };
    const users = new Set<string>();
    const teams = new Set<string>();

    for (const table of OLD_TABLE_NAMES) {
        const rawRows = source.get(table);
        if (!rawRows) plan.warnings.push(`${table}: not in the source (0 rows)`);
        const report: TableReport = {
            table,
            newTable: newTableFor(table),
            read: 0,
            mapped: 0,
            failed: 0,
        };
        plan.report.push(report);
        const seenKeys = new Set<string>();
        const seenOwners = new Set<string>();

        for (const [index, raw] of (rawRows ?? []).entries()) {
            report.read++;
            try {
                const mapped = ROW_MAPPERS[table](raw);
                const refs = mapped as {
                    oauth_id?: string;
                    id?: string;
                    twitch_user?: string;
                    team?: string | null;
                };
                const key = refs.oauth_id ?? refs.id ?? '';
                if (seenKeys.has(key)) {
                    throw new RowMappingError(
                        table === 'TwitchUser' ? 'oauthId' : 'id',
                        `duplicate key ${key}`,
                    );
                }
                if (refs.twitch_user !== undefined) {
                    if (!users.has(refs.twitch_user)) {
                        throw new RowMappingError(
                            'userOauthId',
                            `TwitchUser ${refs.twitch_user} is not being imported`,
                        );
                    }
                    // One team / registration / token per user (unique in both schemas).
                    if (table !== 'Pokemon') {
                        if (seenOwners.has(refs.twitch_user)) {
                            throw new RowMappingError(
                                'userOauthId',
                                `a second ${table} row for user ${refs.twitch_user}`,
                            );
                        }
                        seenOwners.add(refs.twitch_user);
                    }
                }
                if (refs.team && !teams.has(refs.team)) {
                    throw new RowMappingError(
                        'teamId',
                        `PokemonTeam ${refs.team} is not being imported`,
                    );
                }
                seenKeys.add(key);
                if (table === 'TwitchUser') users.add(key);
                if (table === 'PokemonTeam') teams.add(key);
                (plan.rows[table] as unknown[]).push(mapped);
                report.mapped++;
            } catch (error) {
                if (!(error instanceof RowMappingError)) throw error;
                report.failed++;
                plan.failures.push({
                    table,
                    row: index + 1,
                    key: keyOf(raw),
                    reason: error.message,
                });
                if (!options.continueOnFailure) {
                    plan.aborted = true;
                    return plan;
                }
            }
        }
    }

    const slots = new Map<string, number>();
    for (const pokemon of plan.rows.Pokemon) {
        if (pokemon.team === null) continue;
        const slotKey = `${pokemon.team}#${pokemon.slot}`;
        slots.set(slotKey, (slots.get(slotKey) ?? 0) + 1);
    }
    const shared = [...slots.entries()].filter(([, count]) => count > 1);
    if (shared.length > 0) {
        // The old bot tolerated two Pokémon in one slot (and de-duplicated on
        // redeem). The new schema allows it too; this is for the operator.
        plan.warnings.push(
            `Pokemon: ${shared.length} (team, slot) pair(s) hold more than one Pokémon: ${shared
                .slice(0, 10)
                .map(([slotKey, count]) => `${slotKey} ×${count}`)
                .join(', ')}${shared.length > 10 ? ', …' : ''}`,
        );
    }
    return plan;
}

export interface ApplyOptions {
    /** Rows per upsert statement. */
    chunkSize?: number;
}

/**
 * Upsert the plan through MikroORM, parents first, in one transaction: a
 * failure anywhere leaves the target database as it was. Keyed on the old
 * primary keys, so running the same dump twice writes the same rows.
 * Returns the number of rows written per new table.
 */
export async function applyImport(
    em: EntityManager,
    plan: ImportPlan,
    { chunkSize = 500 }: ApplyOptions = {},
): Promise<Record<string, number>> {
    if (plan.aborted) throw new Error('refusing to apply an aborted plan');
    const written: Record<string, number> = {};
    await em.fork().transactional(async tx => {
        for (const table of OLD_TABLE_NAMES) {
            const target = TARGETS[table];
            const rows = plan.rows[table] as unknown as EntityData<object>[];
            for (let start = 0; start < rows.length; start += chunkSize) {
                await tx.upsertMany(target.entity, rows.slice(start, start + chunkSize), {
                    onConflictFields: [target.key] as never[],
                    onConflictAction: 'merge',
                    ...(target.keep ? { onConflictExcludeFields: target.keep as never[] } : {}),
                });
                // Nothing here is edited after it is written; keep the identity map small.
                tx.clear();
            }
            written[target.table] = rows.length;
        }
    });
    return written;
}

/** Row counts of the new tables, for comparing against the old database after an import. */
export async function countNewTables(em: EntityManager): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const connection = em.fork().getConnection();
    for (const table of OLD_TABLE_NAMES) {
        const name = newTableFor(table);
        const [row] = await connection.execute<{ count: string }[]>(
            `select count(*)::text as count from "${name}"`,
        );
        counts[name] = Number(row.count);
    }
    return counts;
}
