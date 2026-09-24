import { IGNORED_OLD_TABLES, isOldTable, OLD_TABLES } from './old-schema';
import type { OldTable, RawRow } from './old-schema';

/**
 * Readers for the two text forms Postgres hands the import: the `COPY` blocks
 * of a plain `pg_dump --data-only`, and array literals (`{a,"b c",NULL}`).
 */

/** A dump the reader cannot use at all (as opposed to one row it cannot map). */
export class DumpFormatError extends Error {
    override name = 'DumpFormatError';
}

export interface ParsedDump {
    /** Rows per old table, in dump order. Tables absent from the dump are absent here. */
    tables: Map<OldTable, RawRow[]>;
    /** Tables in the dump that the import skips (Session, Prisma's own bookkeeping, anything unknown). */
    skippedTables: string[];
}

const COPY_HEADER =
    /^COPY\s+(?:"?([A-Za-z_][\w$]*)"?\.)?"?([^"\s(]+)"?\s*\(([^)]*)\)\s+FROM\s+stdin;\s*$/i;

/** `"oauthId", roles` → `['oauthId', 'roles']`. */
function columnList(raw: string): string[] {
    return raw.split(',').map(column =>
        column
            .trim()
            .replace(/^"(.*)"$/, '$1')
            .replace(/""/g, '"'),
    );
}

/**
 * Every `COPY … FROM stdin;` block of a plain-format `pg_dump`
 * (`--data-only`, or a full dump — schema statements are ignored). Rows are
 * keyed by column name, so the dump's column order does not matter; a table
 * missing one of the old schema's columns is a format error.
 */
export function parseCopyDump(text: string): ParsedDump {
    if (text.startsWith('PGDMP')) {
        throw new DumpFormatError(
            'this is a custom-format dump; re-run pg_dump with --format=plain (or restore it and use DATABASE_URL_OLD)',
        );
    }
    const tables = new Map<OldTable, RawRow[]>();
    const skippedTables: string[] = [];
    const lines = text.split('\n');
    let copies = 0;
    let inserts = 0;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].replace(/\r$/, '');
        if (/^INSERT INTO /i.test(line)) inserts++;
        const header = COPY_HEADER.exec(line);
        if (!header) continue;
        copies++;

        const table = header[2];
        const columns = columnList(header[3]);
        const rows: RawRow[] = [];
        index++;
        for (; index < lines.length; index++) {
            const data = lines[index].replace(/\r$/, '');
            if (data === '\\.') break;
            const fields = data.split('\t');
            if (fields.length !== columns.length) {
                throw new DumpFormatError(
                    `line ${index + 1}: ${table} has ${columns.length} columns but the row has ${
                        fields.length
                    } fields`,
                );
            }
            rows.push(
                Object.fromEntries(
                    columns.map((column, i) => [column, decodeCopyField(fields[i])]),
                ),
            );
        }
        if (index >= lines.length)
            throw new DumpFormatError(`${table}: COPY block is not terminated by \\.`);

        if (!isOldTable(table)) {
            skippedTables.push(table);
            continue;
        }
        const missing = OLD_TABLES[table].filter(column => !columns.includes(column));
        if (missing.length > 0) {
            throw new DumpFormatError(
                `${table} is missing column(s) ${missing.join(
                    ', ',
                )} — is this the brobot Prisma database?`,
            );
        }
        tables.set(table, [...(tables.get(table) ?? []), ...rows]);
    }

    if (copies === 0 && inserts > 0) {
        throw new DumpFormatError(
            'this dump uses INSERT statements; re-run pg_dump without --inserts/--column-inserts',
        );
    }
    if (copies === 0)
        throw new DumpFormatError('no COPY blocks found; expected a plain-format pg_dump');
    return { tables, skippedTables };
}

/** Whether `name` is a table the import knowingly ignores (vs. one it has never heard of). */
export function isIgnoredTable(name: string): boolean {
    return (IGNORED_OLD_TABLES as readonly string[]).includes(name);
}

const SIMPLE_ESCAPES: Record<string, string> = {
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
};

/**
 * One field of `COPY … TO stdout` text format: `\N` is NULL; backslash
 * escapes `\b \f \n \r \t \v`, `\ooo` (octal byte), `\xhh` (hex byte), and a
 * backslash before any other character is that character.
 */
export function decodeCopyField(field: string): string | null {
    if (field === '\\N') return null;
    if (!field.includes('\\')) return field;

    let out = '';
    let bytes: number[] = [];
    const flushBytes = () => {
        if (bytes.length > 0) out += Buffer.from(bytes).toString('utf8');
        bytes = [];
    };

    for (let i = 0; i < field.length; i++) {
        const char = field[i];
        if (char !== '\\' || i === field.length - 1) {
            flushBytes();
            out += char;
            continue;
        }
        const next = field[i + 1];
        const octal = /^[0-7]{1,3}/.exec(field.slice(i + 1, i + 4));
        const hex = next === 'x' ? /^[0-9A-Fa-f]{1,2}/.exec(field.slice(i + 2, i + 4)) : null;
        if (octal) {
            bytes.push(parseInt(octal[0], 8) & 0xff);
            i += octal[0].length;
        } else if (hex) {
            bytes.push(parseInt(hex[0], 16));
            i += 1 + hex[0].length;
        } else {
            flushBytes();
            out += SIMPLE_ESCAPES[next] ?? next;
            i += 1;
        }
    }
    flushBytes();
    return out;
}

/**
 * A one-dimensional Postgres array literal as text — `{}`, `{a,b}`,
 * `{"a b","say \"hi\"",NULL}` — into its elements (`null` for an unquoted
 * NULL). Throws on anything else (nested arrays, explicit bounds).
 */
export function parsePgArray(literal: string): (string | null)[] {
    const text = literal.trim();
    if (!text.startsWith('{') || !text.endsWith('}'))
        throw new Error(`not an array literal: ${JSON.stringify(literal)}`);
    const body = text.slice(1, -1);
    if (body.trim() === '') return [];

    const elements: (string | null)[] = [];
    let i = 0;
    while (i <= body.length) {
        while (body[i] === ' ') i++;
        if (body[i] === '{') throw new Error('nested arrays are not supported');
        let value: string | null;
        if (body[i] === '"') {
            let quoted = '';
            i++;
            while (i < body.length && body[i] !== '"') {
                if (body[i] === '\\') i++;
                quoted += body[i] ?? '';
                i++;
            }
            if (body[i] !== '"')
                throw new Error(`unterminated quoted element in ${JSON.stringify(literal)}`);
            i++;
            value = quoted;
        } else {
            let bare = '';
            while (i < body.length && body[i] !== ',') {
                if (body[i] === '\\') i++;
                bare += body[i] ?? '';
                i++;
            }
            bare = bare.trim();
            value = bare.toUpperCase() === 'NULL' ? null : bare;
        }
        elements.push(value);
        while (body[i] === ' ') i++;
        if (i >= body.length) break;
        if (body[i] !== ',')
            throw new Error(`unexpected ${JSON.stringify(body[i])} in ${JSON.stringify(literal)}`);
        i++;
    }
    return elements;
}
