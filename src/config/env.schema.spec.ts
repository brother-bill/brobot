import { ENV_KEYS, EnvValidationError, envKeyMeta, envSchema, parseEnv } from './env.schema';
import { RAW_TEST_ENV } from '../../test/helpers';

function parseWith(overrides: Record<string, string | undefined>) {
    const raw: Record<string, string | undefined> = { ...RAW_TEST_ENV, ...overrides };
    for (const key of Object.keys(raw)) if (raw[key] === undefined) delete raw[key];
    return parseEnv(raw);
}

function issuesOf(overrides: Record<string, string | undefined>): string[] {
    try {
        parseWith(overrides);
    } catch (error) {
        if (error instanceof EnvValidationError) return [...error.issues];
        throw error;
    }
    throw new Error('expected validation to fail');
}

describe('parseEnv', () => {
    it('accepts a complete environment and normalises it', () => {
        const env = parseWith({});
        expect(env.ALLOWED_ORIGINS).toEqual(['https://brobot.test', 'http://localhost:4200']);
        expect(env.PORT).toBe(3000);
        expect(env.RUN_MIGRATIONS).toBe(true);
        expect(env.OPEN_API_KEY).toBeUndefined();
    });

    it('names a missing required variable instead of defaulting it', () => {
        expect(issuesOf({ TWITCH_CLIENT_ID: undefined })).toEqual(['TWITCH_CLIENT_ID: is required but not set']);
    });

    it('reports every problem at once', () => {
        const issues = issuesOf({ DATABASE_URL: undefined, JWT_ACCESS_SECRET: 'short', WS_SECRET: undefined });
        expect(issues).toHaveLength(3);
        expect(issues.join('\n')).toMatch(/DATABASE_URL: is required/);
        expect(issues.join('\n')).toMatch(/JWT_ACCESS_SECRET: must be at least 32 characters/);
        expect(issues.join('\n')).toMatch(/WS_SECRET: is required/);
    });

    it("never yields the old `origin: ['']` — an empty ALLOWED_ORIGINS fails", () => {
        expect(issuesOf({ ALLOWED_ORIGINS: '' }).join('\n')).toMatch(/ALLOWED_ORIGINS/);
        expect(issuesOf({ ALLOWED_ORIGINS: ' , ' }).join('\n')).toMatch(/at least one origin/);
    });

    it('refuses origins with a path or trailing slash', () => {
        expect(issuesOf({ ALLOWED_ORIGINS: 'https://brobot.test/' }).join('\n')).toMatch(/bare origin/);
        expect(issuesOf({ ALLOWED_ORIGINS: 'https://brobot.test/admin' }).join('\n')).toMatch(/bare origin/);
    });

    it('requires UI_URL to be one of the allowed origins', () => {
        expect(issuesOf({ UI_URL: 'https://elsewhere.test' })).toEqual([
            'UI_URL: origin https://elsewhere.test is not in ALLOWED_ORIGINS — the UI the login redirects to could not call the API',
        ]);
    });

    it('refuses identical access and refresh secrets', () => {
        expect(issuesOf({ JWT_REFRESH_SECRET: RAW_TEST_ENV.JWT_ACCESS_SECRET }).join('\n')).toMatch(
            /JWT_REFRESH_SECRET: must differ/,
        );
    });

    it('checks Twitch ids are numeric', () => {
        expect(issuesOf({ TWITCH_STREAMER_OAUTH_ID: '00000000x' }).join('\n')).toMatch(/numeric Twitch user id/);
    });

    it('treats a blank optional integration key as absent', () => {
        expect(parseWith({ LICHESS_AUTH_TOKEN: '   ' }).LICHESS_AUTH_TOKEN).toBeUndefined();
        expect(parseWith({ LICHESS_AUTH_TOKEN: 'lip_x' }).LICHESS_AUTH_TOKEN).toBe('lip_x');
    });

    it('reads RUN_MIGRATIONS=false as false', () => {
        expect(parseWith({ RUN_MIGRATIONS: 'false' }).RUN_MIGRATIONS).toBe(false);
    });
});

describe('env key metadata', () => {
    it('labels every key', () => {
        for (const name of ENV_KEYS) expect(() => envKeyMeta(name), name).not.toThrow();
    });

    it('says a key is required exactly when parseEnv requires it', () => {
        for (const name of ENV_KEYS) {
            const required = !envSchema.shape[name].safeParse(undefined).success;
            expect(envKeyMeta(name).requiredBy !== undefined, name).toBe(required);
        }
    });

    it('states the default parseEnv applies, as an env file would hold it', () => {
        for (const name of ENV_KEYS) {
            const parsed = envSchema.shape[name].safeParse(undefined);
            const applied = parsed.success && parsed.data !== undefined ? String(parsed.data) : undefined;
            expect(envKeyMeta(name).default, name).toBe(applied);
        }
    });

    it('keeps exactly what the k3s deploy provides out of the config store', () => {
        // bootstrap keys never reach the bundle; changing this set changes what
        // the brobot chart must inject itself.
        expect(ENV_KEYS.filter(name => envKeyMeta(name).kind === 'bootstrap')).toEqual([
            'NODE_ENV',
            'PORT',
            'DATABASE_URL',
            'RUN_MIGRATIONS',
        ]);
    });
});
