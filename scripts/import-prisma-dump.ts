/**
 * Old Prisma database → new schema (ticket B3). Run from apps/brobot:
 *
 *   pnpm run import:prisma-dump -- dump.sql --dry-run
 *   DATABASE_URL=postgres://… pnpm run import:prisma-dump -- dump.sql
 *   DATABASE_URL_OLD=postgres://… DATABASE_URL=postgres://… pnpm run import:prisma-dump -- --from-db
 *
 * `--help` for everything else; the logic is in
 * src/modules/transfer/import/import-cli.ts.
 */
import 'reflect-metadata';
import { processIo, runImportCli } from '../src/modules/transfer/import/import-cli';

void runImportCli(process.argv.slice(2), processIo()).then(code => {
    process.exitCode = code;
});
