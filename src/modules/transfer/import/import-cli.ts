import type { EntityManager } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { readFileSync } from 'node:fs';
import { buildOrmConfig } from '../../../mikro-orm.config';
import { readOldDatabase } from './old-database';
import type { OldTable, RawRow } from './old-schema';
import { DumpFormatError, isIgnoredTable, parseCopyDump } from './pg-text';
import { applyImport, countNewTables, planImport } from './prisma-import';
import type { ImportPlan } from './prisma-import';

/**
 * `scripts/import-prisma-dump.ts`: the old Prisma database (a plain
 * `pg_dump --data-only`, or the live database) into the new schema.
 * Everything but process wiring lives here so the tests can drive it.
 */

export const USAGE = `Usage:
  import-prisma-dump <dump.sql> [--dry-run] [--continue]
  import-prisma-dump --from-db   [--dry-run] [--continue]

Loads the old Prisma database of brobot into the new schema through MikroORM.

  <dump.sql>   a plain-format data dump:  pg_dump --data-only --format=plain "$OLD_URL" > dump.sql
  --from-db    read the old database directly from DATABASE_URL_OLD instead
  --dry-run    map every row and print the counts per table and every row that
               cannot be mapped; connect to nothing, write nothing
  --continue   skip rows that cannot be mapped (and the rows that depend on them)
               instead of stopping at the first one

Writes go to DATABASE_URL, in one transaction, upserting on the old primary keys:
running the same dump twice changes nothing. A Pokémon's transfer columns
(active_game, pmd_*) are never overwritten. Sessions are not imported.

Exit codes: 0 done (or dry run clean), 1 a row could not be mapped (without
--continue), 2 bad arguments, unreadable dump, or a database error.`;

export class UsageError extends Error {
    override name = 'UsageError';
}

export interface CliOptions {
    dumpPath: string | null;
    fromDb: boolean;
    dryRun: boolean;
    continueOnFailure: boolean;
    help: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
    const options: CliOptions = {
        dumpPath: null,
        fromDb: false,
        dryRun: false,
        continueOnFailure: false,
        help: false,
    };
    for (const arg of argv) {
        // `pnpm run x -- args` passes the separator through.
        if (arg === '--') continue;
        if (arg === '--dry-run') options.dryRun = true;
        else if (arg === '--continue') options.continueOnFailure = true;
        else if (arg === '--from-db') options.fromDb = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
        else if (options.dumpPath === null) options.dumpPath = arg;
        else throw new UsageError(`unexpected argument ${arg}`);
    }
    if (options.help) return options;
    if (options.fromDb === (options.dumpPath !== null)) {
        throw new UsageError('give exactly one source: a dump file or --from-db');
    }
    return options;
}

export interface Database {
    em: EntityManager;
    close(): Promise<void>;
}

export interface CliIo {
    env: Readonly<Record<string, string | undefined>>;
    readFile(path: string): string;
    connect(url: string): Promise<Database>;
    out(line: string): void;
    err(line: string): void;
}

export function processIo(): CliIo {
    return {
        env: process.env,
        readFile: path => readFileSync(path, 'utf8'),
        connect: async url => {
            const orm = await MikroORM.init({ ...buildOrmConfig(url), logger: () => undefined });
            return { em: orm.em, close: () => orm.close(true) };
        },
        out: line => process.stdout.write(`${line}\n`),
        err: line => process.stderr.write(`${line}\n`),
    };
}

function printPlan(plan: ImportPlan, io: CliIo): void {
    const width = Math.max(
        ...plan.report.map(entry => `${entry.table} → ${entry.newTable}`.length),
    );
    io.out('table'.padEnd(width) + '      read  mapped  failed');
    for (const entry of plan.report) {
        const name = `${entry.table} → ${entry.newTable}`.padEnd(width);
        io.out(
            `${name}  ${String(entry.read).padStart(8)}${String(entry.mapped).padStart(8)}${String(
                entry.failed,
            ).padStart(8)}`,
        );
    }
    for (const failure of plan.failures) {
        io.err(
            `cannot map ${failure.table} row ${failure.row}${
                failure.key ? ` (${failure.key})` : ''
            }: ${failure.reason}`,
        );
    }
    for (const warning of plan.warnings) io.err(`warning: ${warning}`);
}

async function readSource(options: CliOptions, io: CliIo): Promise<Map<OldTable, RawRow[]>> {
    if (options.dumpPath !== null) {
        const dump = parseCopyDump(io.readFile(options.dumpPath));
        for (const table of dump.skippedTables) {
            io.err(`${isIgnoredTable(table) ? 'skipped' : 'skipped unknown table'} ${table}`);
        }
        return dump.tables;
    }
    const url = io.env.DATABASE_URL_OLD;
    if (!url) throw new UsageError('--from-db needs DATABASE_URL_OLD');
    const old = await io.connect(url);
    try {
        return await readOldDatabase(old.em);
    } finally {
        await old.close();
    }
}

/** Runs the import; resolves to the process exit code. */
export async function runImportCli(argv: readonly string[], io: CliIo): Promise<number> {
    try {
        const options = parseArgs(argv);
        if (options.help) {
            io.out(USAGE);
            return 0;
        }
        const target = io.env.DATABASE_URL;
        if (!options.dryRun) {
            if (!target) throw new UsageError('DATABASE_URL (the new database) is not set');
            if (target === io.env.DATABASE_URL_OLD)
                throw new UsageError('DATABASE_URL and DATABASE_URL_OLD are the same database');
        }

        const plan = planImport(await readSource(options, io), {
            continueOnFailure: options.continueOnFailure,
        });
        printPlan(plan, io);
        if (plan.aborted) {
            io.err(
                'stopped at the first row that cannot be mapped; nothing was written (re-run with --continue to skip such rows)',
            );
            return 1;
        }
        if (options.dryRun) {
            io.out(
                `dry run: nothing written${
                    plan.failures.length ? `; ${plan.failures.length} row(s) would be skipped` : ''
                }`,
            );
            return 0;
        }

        const db = await io.connect(target as string);
        try {
            const written = await applyImport(db.em, plan);
            const counts = await countNewTables(db.em);
            io.out('written (upserted) → rows now in the table');
            for (const [table, rows] of Object.entries(written))
                io.out(`  ${table}: ${rows} → ${counts[table]}`);
        } finally {
            await db.close();
        }
        if (plan.failures.length) io.err(`${plan.failures.length} row(s) skipped (--continue)`);
        return 0;
    } catch (error) {
        if (error instanceof UsageError) {
            io.err(`${error.message}\n\n${USAGE}`);
            return 2;
        }
        if (error instanceof DumpFormatError) {
            io.err(`unusable dump: ${error.message}`);
            return 2;
        }
        io.err(
            `import failed, nothing was written: ${
                error instanceof Error ? error.stack ?? error.message : String(error)
            }`,
        );
        return 2;
    }
}
