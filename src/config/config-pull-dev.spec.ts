import { createRequire } from 'node:module';
import { API_URL_ENV, TOKEN_ENV, bootstrapLines, dotenvLine, pullDevConfig, type PullDevIo } from './config-pull-dev';

// The dotenv @nestjs/config loads .env with — not a dependency of brobot itself.
const { parse } = createRequire(require.resolve('@nestjs/config'))('dotenv') as {
    parse: (src: string) => Record<string, string>;
};

const PATHS = { envFile: '/app/.env', exampleFile: '/app/.env.example' };

function harness(options: {
    env?: Record<string, string>;
    status?: number;
    body?: string;
    files?: Record<string, string>;
}) {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const out: string[] = [];
    const err: string[] = [];
    let written: string | null = null;
    const io: PullDevIo = {
        env: options.env ?? { [TOKEN_ENV]: 'cfg_dev' },
        fetch: (url, init) => {
            requests.push({ url, headers: init.headers });
            const status = options.status ?? 200;
            return Promise.resolve({
                ok: status < 300,
                status,
                text: () => Promise.resolve(options.body ?? '{}'),
            });
        },
        readFile: path => options.files?.[path] ?? null,
        replaceEnvFile: content => {
            written = content;
        },
        out: line => out.push(line),
        err: line => err.push(line),
    };
    return { io, requests, out, err, written: () => written };
}

describe('dotenvLine', () => {
    it.each([
        'plain',
        '',
        "it's",
        'with `backtick` and \'quote\'',
        '$HOME and #hash',
        ' padded ',
        'a\\b',
    ])('reads back unchanged through dotenv: %j', value => {
        expect(parse(dotenvLine('KEY', value)).KEY).toBe(value);
    });

    it('refuses what no quote can hold', () => {
        expect(() => dotenvLine('KEY', 'two\nlines')).toThrow(/KEY/);
        expect(() => dotenvLine('KEY', 'ends in \\')).toThrow(/KEY/);
        expect(() => dotenvLine('KEY', `' \` " all three`)).toThrow(/KEY/);
    });
});

describe('bootstrapLines', () => {
    it('keeps only bootstrap assignments, verbatim', () => {
        const kept = bootstrapLines(
            ['# comment', 'NODE_ENV=development', 'export DATABASE_URL="postgres://x"', 'WS_SECRET=abc'].join('\n'),
        );
        expect([...kept.entries()]).toEqual([
            ['NODE_ENV', 'NODE_ENV=development'],
            ['DATABASE_URL', 'export DATABASE_URL="postgres://x"'],
        ]);
    });
});

describe('pullDevConfig', () => {
    it('refuses without a token in the environment, and never calls the store', async () => {
        const h = harness({ env: {} });
        expect(await pullDevConfig(h.io, PATHS)).toBe(2);
        expect(h.requests).toEqual([]);
        expect(h.err.join('\n')).toMatch(TOKEN_ENV);
    });

    it('asks for the brobot/dev bundle with the bearer token', async () => {
        const h = harness({ env: { [TOKEN_ENV]: 'cfg_dev', [API_URL_ENV]: 'http://localhost:3000/api/' } });
        await pullDevConfig(h.io, PATHS);
        expect(h.requests).toEqual([
            {
                url: 'http://localhost:3000/api/config/bundle?app=brobot&env=dev',
                headers: { Authorization: 'Bearer cfg_dev', Accept: 'application/json' },
            },
        ]);
    });

    it('writes the bundle, keeps the bootstrap lines of the current .env, and prints names only', async () => {
        const h = harness({
            body: JSON.stringify({ WS_SECRET: 'sekrit-value', DOMAIN: 'localhost:3000' }),
            files: {
                [PATHS.envFile]: 'DATABASE_URL=postgres://mine\nWS_SECRET=old\nTWITCH_BOT_ENABLED=false\n',
                [PATHS.exampleFile]: 'DATABASE_URL=postgres://example\n',
            },
        });
        expect(await pullDevConfig(h.io, PATHS)).toBe(0);
        expect(parse(h.written() ?? '')).toEqual({
            DATABASE_URL: 'postgres://mine',
            DOMAIN: 'localhost:3000',
            WS_SECRET: 'sekrit-value',
        });
        expect([...h.out, ...h.err].join('\n')).not.toMatch(/sekrit-value|postgres:\/\/mine/);
    });

    it('takes the bootstrap lines from .env.example when there is no .env', async () => {
        const h = harness({
            files: { [PATHS.exampleFile]: 'NODE_ENV=development\nDATABASE_URL=postgres://example\nWS_SECRET=\n' },
        });
        expect(await pullDevConfig(h.io, PATHS)).toBe(0);
        expect(parse(h.written() ?? '')).toEqual({
            NODE_ENV: 'development',
            DATABASE_URL: 'postgres://example',
        });
    });

    it('names a required bootstrap key it could not keep', async () => {
        const h = harness({ files: {} });
        expect(await pullDevConfig(h.io, PATHS)).toBe(0);
        expect(h.err.join('\n')).toMatch(/DATABASE_URL/);
    });

    it('writes nothing when the store refuses', async () => {
        const h = harness({ status: 409, body: '{"message":"missing required keys: WS_SECRET"}' });
        expect(await pullDevConfig(h.io, PATHS)).toBe(1);
        expect(h.written()).toBeNull();
        expect(h.err.join('\n')).toMatch(/409.*WS_SECRET/);
    });

    it('writes nothing when the answer is not a bundle', async () => {
        const h = harness({ body: '["not", "a", "bundle"]' });
        expect(await pullDevConfig(h.io, PATHS)).toBe(1);
        expect(h.written()).toBeNull();
    });
});
