import type { EntityManager } from '@mikro-orm/core';
import { OLD_TABLE_NAMES, OLD_TABLES } from './old-schema';
import type { OldTable, RawRow } from './old-schema';

/** Postgres' `undefined_table`. */
const UNDEFINED_TABLE = '42P01';

function quote(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Read the old tables straight out of a live Prisma database
 * (`DATABASE_URL_OLD`). Every column is selected `::text`, so the rows come
 * back exactly as a `COPY` dump prints them and go through the same mappers —
 * one input format, and no driver-side timestamp or array parsing to trust.
 * A table that does not exist is left out, as if the dump lacked it.
 */
export async function readOldDatabase(em: EntityManager): Promise<Map<OldTable, RawRow[]>> {
    const connection = em.fork().getConnection();
    const tables = new Map<OldTable, RawRow[]>();
    for (const table of OLD_TABLE_NAMES) {
        const columns = OLD_TABLES[table];
        const select = columns
            .map(column => `${quote(column)}::text as ${quote(column)}`)
            .join(', ');
        try {
            const rows = await connection.execute<RawRow[]>(
                `select ${select} from ${quote(table)} order by ${quote(columns[0])}`,
            );
            tables.set(table, rows);
        } catch (error) {
            if ((error as { code?: string }).code === UNDEFINED_TABLE) continue;
            throw error;
        }
    }
    return tables;
}
