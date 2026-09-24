import { z } from 'zod';

/**
 * Every environment variable brobot reads, validated once at boot.
 *
 * The old app read `process.env` wherever it happened to need a value and
 * defaulted the misses: `enableCors({ origin: [process.env.UI_URL || ''] })`
 * ran in production with `UI_URL` unset, which is `origin: ['']`, and the
 * streamer check compared ids against a hard-coded `'00000000'` fallback. A
 * missing variable here is a boot failure that names the variable, not a
 * silently wrong server.
 *
 * Optional variables are optional because the feature that reads them can be
 * switched off, not because a default is safe: a third-party key that is
 * absent disables that integration (B2 decides how), it is never replaced.
 */

/** Twitch user ids are decimal strings; the old code parsed them with parseInt. */
const twitchUserId = z.string().regex(/^\d+$/, 'must be a numeric Twitch user id');

const httpUrl = z.url({ protocol: /^https?$/ });

/**
 * A browser origin: scheme + host (+ port), nothing else. `https://a.b/` with a
 * trailing slash or a path is refused rather than normalised, because the
 * browser sends the bare origin and a near-miss here is a CORS failure that
 * only shows up in somebody's devtools.
 */
const origin = z.string().refine(value => {
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
    } catch {
        return false;
    }
}, 'must be a bare origin like https://brobot.live (scheme + host + optional port, no path or trailing slash)');

const secret = (min: number) => z.string().min(min, `must be at least ${min} characters`);

const optionalString = z
    .string()
    .optional()
    .transform(value => (value?.trim() ? value.trim() : undefined));

export const envSchema = z
    .object({
        NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
        PORT: z.coerce.number().int().min(1).max(65535).default(3000),

        // Database
        DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
        /** `false` skips `migrator.up()` at boot (local dev with db:schema:dev). */
        RUN_MIGRATIONS: z
            .enum(['true', 'false'])
            .default('true')
            .transform(value => value === 'true'),

        // Public surface
        /** Public hostname of this API (EventSub callback host), e.g. admin.brobot.live. */
        DOMAIN: z.string().regex(/^[a-z0-9.-]+(:\d+)?$/i, 'must be a bare hostname, no scheme'),
        /** Where the OAuth callbacks send the browser afterwards. Must be one of ALLOWED_ORIGINS. */
        UI_URL: httpUrl,
        /** Comma-separated browser origins allowed by CORS. At least one; never empty. */
        ALLOWED_ORIGINS: z
            .string()
            .transform(raw =>
                raw
                    .split(',')
                    .map(value => value.trim())
                    .filter(value => value.length > 0),
            )
            .pipe(z.array(origin).min(1, 'must list at least one origin')),

        // Auth (brobot's own)
        JWT_ACCESS_SECRET: secret(32),
        JWT_REFRESH_SECRET: secret(32),
        /** Shared bearer secret for api-time → brobot calls (/api/internal/transfer/*). */
        BROBOT_SERVICE_TOKEN: secret(32),

        // Twitch application
        TWITCH_CLIENT_ID: z.string().min(1),
        TWITCH_CLIENT_SECRET: z.string().min(1),
        TWITCH_CALLBACK_URL_USER: httpUrl,
        TWITCH_CALLBACK_URL_STREAMER: httpUrl,
        TWITCH_CALLBACK_URL_BOT: httpUrl,
        /** The only Twitch account allowed through the streamer flow. */
        TWITCH_STREAMER_OAUTH_ID: twitchUserId,
        /** The only Twitch account allowed through the bot flow. */
        TWITCH_BOT_OAUTH_ID: twitchUserId,
        TWITCH_STREAMER_CHANNEL_LISTEN: z.string().min(1),
        TWITCH_BOT_USERNAME: z.string().min(1),
        /** Twurple requires 10–100 characters for an EventSub secret. */
        EVENT_SUB_SECRET: z.string().min(10).max(100),

        /** Secret the streamer client presents on /api/ashketchum. */
        WS_SECRET: secret(16),

        // Integrations (optional: absent disables the feature)
        RIOT_API_KEY: optionalString,
        LICHESS_AUTH_TOKEN: optionalString,
        OPEN_API_KEY: optionalString,
        STREAMLABS_CLIENT_ID: optionalString,
        STREAMLABS_SECRET: optionalString,
        STREAMLABS_REDIRECT_URI: optionalString,
    })
    .superRefine((env, ctx) => {
        const uiOrigin = new URL(env.UI_URL).origin;
        if (!env.ALLOWED_ORIGINS.includes(uiOrigin)) {
            ctx.addIssue({
                code: 'custom',
                path: ['UI_URL'],
                message: `origin ${uiOrigin} is not in ALLOWED_ORIGINS — the UI the login redirects to could not call the API`,
            });
        }
        if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
            ctx.addIssue({
                code: 'custom',
                path: ['JWT_REFRESH_SECRET'],
                message: 'must differ from JWT_ACCESS_SECRET, or a refresh token is accepted as an access token',
            });
        }
    });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
    constructor(readonly issues: readonly string[]) {
        super(`Invalid environment — brobot refuses to start:\n  - ${issues.join('\n  - ')}`);
        this.name = 'EnvValidationError';
    }
}

/**
 * Parse and validate an environment. Throws {@link EnvValidationError} listing
 * EVERY problem at once, so a fresh deploy is fixed in one pass rather than
 * one variable per restart.
 */
export function parseEnv(raw: Record<string, unknown>): Env {
    const result = envSchema.safeParse(raw);
    if (!result.success) {
        throw new EnvValidationError(
            result.error.issues.map(issue => {
                const name = issue.path.join('.') || '(root)';
                const missing = issue.code === 'invalid_type' && raw[name] === undefined;
                return `${name}: ${missing ? 'is required but not set' : issue.message}`;
            }),
        );
    }
    return result.data;
}
