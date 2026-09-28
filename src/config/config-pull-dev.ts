import { ENV_KEYS, envKeyMeta } from './env.schema';

/**
 * `pnpm run config:pull-dev` — writes brobot's `.env` from the config store's
 * dev bundle (`GET /api/config/bundle?app=brobot&env=dev`), so a developer
 * never copies secrets around by hand.
 *
 * The token is a personal, revocable `cfg_…` bundle token scoped to
 * brobot/dev, read from BROBOT_CONFIG_TOKEN and never from argv (argv lands in
 * shell history and `ps`). CONFIG_API_URL points at another api-time.
 *
 * The bundle never holds a `bootstrap` key (DATABASE_URL, NODE_ENV, …): the
 * store refuses them. Those lines are kept verbatim from the current `.env`,
 * or taken from `.env.example` when there is none. Everything else in `.env`
 * is replaced; the previous file is kept as `.env.prev`. Only key names are
 * printed, never a value.
 */

export const TOKEN_ENV = 'BROBOT_CONFIG_TOKEN';
export const API_URL_ENV = 'CONFIG_API_URL';
export const DEFAULT_API_URL = 'https://api.tahatime.com/api';

export interface PullDevIo {
    env: Readonly<Record<string, string | undefined>>;
    fetch: (url: string, init: { headers: Record<string, string> }) => Promise<{
        ok: boolean;
        status: number;
        text: () => Promise<string>;
    }>;
    /** The file's contents, or null when it does not exist. */
    readFile: (path: string) => string | null;
    /** Replaces `.env`: the old file to `.env.prev`, the new one written mode 600. */
    replaceEnvFile: (content: string) => void;
    out: (line: string) => void;
    err: (line: string) => void;
}

export interface PullDevPaths {
    envFile: string;
    exampleFile: string;
}

const BOOTSTRAP_KEYS = new Set<string>(ENV_KEYS.filter(name => envKeyMeta(name).kind === 'bootstrap'));

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** The lines of a dotenv file that assign a bootstrap key, verbatim. */
export function bootstrapLines(dotenv: string): Map<string, string> {
    const lines = new Map<string, string>();
    for (const line of dotenv.split(/\r?\n/)) {
        const name = ASSIGNMENT.exec(line)?.[1];
        if (name && BOOTSTRAP_KEYS.has(name)) lines.set(name, line);
    }
    return lines;
}

/**
 * `KEY=value` that the dotenv parser @nestjs/config uses reads back as exactly
 * `value`. dotenv does not unescape: single quotes and backticks are literal,
 * double quotes only expand `\n` and `\r`, so the value picks a quote it does
 * not contain. One no quote can hold, or holding a newline, is refused.
 */
export function dotenvLine(name: string, value: string): string {
    const unquotable = new Error(`${name}: the value cannot be written to a dotenv file unchanged`);
    if (/[\r\n]/.test(value) || value.endsWith('\\')) throw unquotable;
    if (!value.includes("'")) return `${name}='${value}'`;
    if (!value.includes('`')) return `${name}=\`${value}\``;
    if (!value.includes('"') && !/\\[nr]/.test(value)) return `${name}="${value}"`;
    throw unquotable;
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every(entry => typeof entry === 'string')
    );
}

/** Returns the exit code. */
export async function pullDevConfig(io: PullDevIo, paths: PullDevPaths): Promise<number> {
    const token = io.env[TOKEN_ENV]?.trim();
    if (!token) {
        io.err(
            `config:pull-dev: set ${TOKEN_ENV} to your brobot/dev bundle token (cfg_…). ` +
                'It is read from the environment only, never from the command line.',
        );
        return 2;
    }
    const configured = io.env[API_URL_ENV]?.trim() ?? '';
    const base = (configured.length > 0 ? configured : DEFAULT_API_URL).replace(/\/+$/, '');
    const url = `${base}/config/bundle?app=brobot&env=dev`;

    const response = await io.fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const body = await response.text();
    if (!response.ok) {
        // Error bodies name keys and reasons, never values.
        io.err(`config:pull-dev: ${url} answered ${response.status}: ${body.slice(0, 500)}`);
        return 1;
    }
    let bundle: unknown;
    try {
        bundle = JSON.parse(body);
    } catch {
        bundle = null;
    }
    if (!isStringRecord(bundle)) {
        io.err(`config:pull-dev: ${url} did not answer a JSON object of strings`);
        return 1;
    }

    const current = io.readFile(paths.envFile);
    const bootstrapSource = current === null ? paths.exampleFile : paths.envFile;
    const kept = bootstrapLines(current ?? io.readFile(paths.exampleFile) ?? '');

    const names = Object.keys(bundle).sort();
    let lines: string[];
    try {
        lines = names.map(name => dotenvLine(name, bundle[name]));
    } catch (error) {
        io.err(`config:pull-dev: ${(error as Error).message}. Nothing written.`);
        return 1;
    }

    io.replaceEnvFile(
        [
            `# Written by \`pnpm run config:pull-dev\` from the config store (brobot/dev).`,
            `# Bootstrap keys are kept from ${bootstrapSource}; everything else is replaced on the next pull.`,
            ...kept.values(),
            '',
            ...lines,
            '',
        ].join('\n'),
    );

    io.out(
        `config:pull-dev: wrote ${paths.envFile}${current === null ? '' : ` (previous file kept as ${paths.envFile}.prev)`}`,
    );
    io.out(`  from the store: ${names.join(', ') || '(nothing)'}`);
    io.out(`  kept from ${bootstrapSource}: ${[...kept.keys()].join(', ') || '(nothing)'}`);
    const unknown = names.filter(name => !(ENV_KEYS as readonly string[]).includes(name));
    if (unknown.length > 0) io.out(`  not in brobot's schema (ignored at boot): ${unknown.join(', ')}`);
    const missing = ENV_KEYS.filter(
        name => BOOTSTRAP_KEYS.has(name) && envKeyMeta(name).requiredBy && !kept.has(name),
    );
    if (missing.length > 0) io.err(`config:pull-dev: set ${missing.join(', ')} in .env yourself`);
    return 0;
}
