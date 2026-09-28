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
 *
 * Every key also carries metadata for the singularity config store (api-time's
 * `/admin/config`), in the shape api-time's `src/env/env.schema.ts` uses:
 * `kind`, `description`, `requiredBy`, `default`. It describes this schema, it
 * does not drive it — the zod schema alone decides what boots — and
 * env.schema.spec.ts fails when the two disagree about what is required or
 * defaulted. `env.schema.json` is its JSON export for the store (and anything
 * else that is not TypeScript); regenerate with `pnpm run env:schema`, and
 * env-json-schema.spec.ts fails on drift.
 */

/**
 * The kinds api-time defines (keep the list identical: the store refuses any
 * other). brobot uses the first four.
 *
 * - `bootstrap` — needed before the process can talk to anything, including a
 *   config store. Stays with the deploy (the k3s chart / CNPG Secret), never
 *   the store; the store refuses to hold one.
 * - `secret` — a credential. Write-only once it lives in the config store, and
 *   the only kind `config:import --as-refs` turns into a 1Password reference.
 * - `plain` — a non-secret value that can be read back and diffed.
 * - `topology` — depends on where and how the process runs (hosts, origins); a
 *   candidate for a per-target override.
 * - `hot` — re-read on every use, so it can change without a restart.
 * - `deprecated` — injected somewhere but read by nothing.
 */
export const ENV_KINDS = ['bootstrap', 'secret', 'plain', 'topology', 'hot', 'deprecated'] as const;
export type EnvKind = (typeof ENV_KINDS)[number];

/** api-time's process names. brobot is one process, the API, so its keys say `api`. */
export type EnvProcess = 'api' | 'worker' | 'both';

export const NODE_ENVS = ['development', 'production', 'test'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export interface EnvKeyMeta {
    kind: EnvKind;
    description: string;
    /** Absent = optional in every NODE_ENV. */
    requiredBy?: { process: EnvProcess; nodeEnv: readonly NodeEnv[] };
    /** The fallback the schema applies when the key is unset, as the string an env file would hold. */
    default?: string;
    /** For a fallback that depends on NODE_ENV. */
    defaultByNodeEnv?: Partial<Record<NodeEnv, string>>;
    /** Set for kind `deprecated`; JSON Schema's own keyword, so generic tooling understands it too. */
    deprecated?: true;
}

/** The metadata of every key, emitted into env.schema.json. */
export const envRegistry = z.registry<EnvKeyMeta>();

/** parseEnv requires the key whatever NODE_ENV is. */
const ALWAYS = { process: 'api', nodeEnv: NODE_ENVS } as const;

/** Registers a key's metadata. Each call needs its own schema instance: the registry is keyed by instance. */
function key<S extends z.ZodType>(meta: EnvKeyMeta, schema: S): S {
    envRegistry.add(schema, meta);
    return schema;
}

/** Twitch user ids are decimal strings; the old code parsed them with parseInt. */
const twitchUserId = () => z.string().regex(/^\d+$/, 'must be a numeric Twitch user id');

const httpUrl = () => z.url({ protocol: /^https?$/ });

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

/** A `true` / `false` environment switch. Anything else is a boot failure, not a guess. */
const flag = (fallback: 'true' | 'false') =>
    z
        .enum(['true', 'false'])
        .default(fallback)
        .transform(value => value === 'true');

const optionalString = () =>
    z
        .string()
        .optional()
        .transform(value => (value?.trim() ? value.trim() : undefined));

export const envSchema = z
    .object({
        // config/config.module.ts
        NODE_ENV: key(
            {
                kind: 'bootstrap',
                description:
                    'Process mode. production ignores the .env file and reads the injected environment only. Set to production by Dockerfile.brobot.prod.',
                default: 'development',
            },
            z.enum(NODE_ENVS).default('development'),
        ),
        // main.ts
        PORT: key(
            { kind: 'bootstrap', description: 'HTTP port the API listens on.', default: '3000' },
            z.coerce.number().int().min(1).max(65535).default(3000),
        ),

        // Database

        // app.module.ts, mikro-orm.config.ts
        DATABASE_URL: key(
            {
                kind: 'bootstrap',
                description:
                    'Postgres connection string (postgres://…). On k3s it comes from the CNPG cluster Secret, not the config store.',
                requiredBy: ALWAYS,
            },
            z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
        ),
        // main.ts
        /** `false` skips `migrator.up()` at boot (local dev with db:schema:dev). */
        RUN_MIGRATIONS: key(
            {
                kind: 'bootstrap',
                description:
                    'Apply pending MikroORM migrations at boot, before listening. "false" skips them (local dev with db:schema:dev).',
                default: 'true',
            },
            z
                .enum(['true', 'false'])
                .default('true')
                .transform(value => value === 'true'),
        ),

        // Public surface

        // modules/twitch/eventsub.service.ts
        /** Public hostname of this API (EventSub callback host), e.g. admin.brobot.live. */
        DOMAIN: key(
            {
                kind: 'topology',
                description:
                    'Public hostname of this API, no scheme (e.g. admin.brobot.live). EventSub callbacks go to https://$DOMAIN/twitch/….',
                requiredBy: ALWAYS,
            },
            z.string().regex(/^[a-z0-9.-]+(:\d+)?$/i, 'must be a bare hostname, no scheme'),
        ),
        // modules/auth/auth.controller.ts, modules/twitch/ui-links.ts
        /** Where the OAuth callbacks send the browser afterwards. Must be one of ALLOWED_ORIGINS. */
        UI_URL: key(
            {
                kind: 'plain',
                description:
                    'The public site (brobot-admin-ui): where the OAuth callbacks send the browser, and the base of the links the bot posts in chat. Its origin must be in ALLOWED_ORIGINS.',
                requiredBy: ALWAYS,
            },
            httpUrl(),
        ),
        // bootstrap.ts
        /** Comma-separated browser origins allowed by CORS. At least one; never empty. */
        ALLOWED_ORIGINS: key(
            {
                kind: 'topology',
                description:
                    'Comma-separated bare browser origins (scheme://host[:port]) allowed by CORS. At least one.',
                requiredBy: ALWAYS,
            },
            z
                .string()
                .transform(raw =>
                    raw
                        .split(',')
                        .map(value => value.trim())
                        .filter(value => value.length > 0),
                )
                .pipe(z.array(origin).min(1, 'must list at least one origin')),
        ),

        // Auth (brobot's own)

        // modules/auth/token.service.ts
        JWT_ACCESS_SECRET: key(
            {
                kind: 'secret',
                description:
                    'Signs brobot session access tokens. At least 32 characters, different from JWT_REFRESH_SECRET. Rotating it signs everyone out.',
                requiredBy: ALWAYS,
            },
            secret(32),
        ),
        // modules/auth/token.service.ts
        JWT_REFRESH_SECRET: key(
            {
                kind: 'secret',
                description:
                    'Signs brobot session refresh tokens. At least 32 characters, different from JWT_ACCESS_SECRET.',
                requiredBy: ALWAYS,
            },
            secret(32),
        ),
        // modules/transfer/service-token.guard.ts
        /** Shared bearer secret for api-time → brobot calls (/api/internal/transfer/*). */
        BROBOT_SERVICE_TOKEN: key(
            {
                kind: 'secret',
                description:
                    "Bearer secret api-time presents on /api/internal/transfer/*; api-time's own BROBOT_SERVICE_TOKEN holds the same value. At least 32 characters.",
                requiredBy: ALWAYS,
            },
            secret(32),
        ),

        // Twitch application

        // modules/auth/twitch-oauth.client.ts, modules/auth/twitch-token-store.service.ts, modules/twitch/eventsub.service.ts
        TWITCH_CLIENT_ID: key(
            { kind: 'plain', description: 'Client id of the Twitch application.', requiredBy: ALWAYS },
            z.string().min(1),
        ),
        // modules/auth/twitch-oauth.client.ts, modules/auth/twitch-token-store.service.ts, modules/twitch/eventsub.service.ts
        TWITCH_CLIENT_SECRET: key(
            { kind: 'secret', description: 'Client secret of the Twitch application.', requiredBy: ALWAYS },
            z.string().min(1),
        ),
        // modules/auth/twitch-oauth.client.ts
        TWITCH_CALLBACK_URL_USER: key(
            {
                kind: 'plain',
                description:
                    'Redirect URI of the viewer login flow (…/api/auth/twitch/callback); must be registered on the Twitch application.',
                requiredBy: ALWAYS,
            },
            httpUrl(),
        ),
        // modules/auth/twitch-oauth.client.ts
        TWITCH_CALLBACK_URL_STREAMER: key(
            {
                kind: 'plain',
                description:
                    'Redirect URI of the streamer flow (…/api/auth/twitch/streamer/callback); must be registered on the Twitch application.',
                requiredBy: ALWAYS,
            },
            httpUrl(),
        ),
        // modules/auth/twitch-oauth.client.ts
        TWITCH_CALLBACK_URL_BOT: key(
            {
                kind: 'plain',
                description:
                    'Redirect URI of the bot flow (…/api/auth/twitch/bot/callback); must be registered on the Twitch application.',
                requiredBy: ALWAYS,
            },
            httpUrl(),
        ),
        // modules/auth/twitch-token-store.service.ts, modules/twitch/eventsub.service.ts, modules/twitch/streamer-api.service.ts
        /** The only Twitch account allowed through the streamer flow. */
        TWITCH_STREAMER_OAUTH_ID: key(
            {
                kind: 'plain',
                description:
                    'Numeric Twitch user id of the streamer: the only account the streamer flow accepts, and the channel EventSub subscribes to.',
                requiredBy: ALWAYS,
            },
            twitchUserId(),
        ),
        // modules/auth/twitch-token-store.service.ts
        /** The only Twitch account allowed through the bot flow. */
        TWITCH_BOT_OAUTH_ID: key(
            {
                kind: 'plain',
                description: 'Numeric Twitch user id of the bot account: the only account the bot flow accepts.',
                requiredBy: ALWAYS,
            },
            twitchUserId(),
        ),
        // modules/twitch/chat/bot-chat.service.ts, modules/twitch/fun/fun-commands.service.ts, modules/twitch/votes/votes.service.ts
        TWITCH_STREAMER_CHANNEL_LISTEN: key(
            {
                kind: 'plain',
                description: 'Twitch channel (login name) the bot joins and listens to.',
                requiredBy: ALWAYS,
            },
            z.string().min(1),
        ),
        // modules/twitch/chat/bot-chat.service.ts
        TWITCH_BOT_USERNAME: key(
            {
                kind: 'plain',
                description: "The bot account's Twitch login name, as it chats.",
                requiredBy: ALWAYS,
            },
            z.string().min(1),
        ),
        // modules/twitch/eventsub.service.ts
        /** Twurple requires 10–100 characters for an EventSub secret. */
        EVENT_SUB_SECRET: key(
            {
                kind: 'secret',
                description:
                    'Secret Twitch signs EventSub webhook deliveries with. 10–100 characters (Twurple). Required even with TWITCH_EVENTSUB_ENABLED=false.',
                requiredBy: ALWAYS,
            },
            z.string().min(10).max(100),
        ),

        // modules/twitch/streamer.gateway.ts
        /** Secret the streamer client presents on /api/ashketchum. */
        WS_SECRET: key(
            {
                kind: 'secret',
                description:
                    'Secret the streamer client (brobot-client) presents on the /api/ashketchum socket. At least 16 characters.',
                requiredBy: ALWAYS,
            },
            secret(16),
        ),

        // The bot

        // modules/twitch/chat/bot-chat.service.ts, modules/twitch/eventsub.service.ts,
        // modules/twitch/fun/fun-commands.service.ts, modules/twitch/pokemon/pokemon-drops.service.ts,
        // modules/twitch/streamer-api.service.ts
        /**
         * `false` keeps the chat bot, drops and channel-point reward handling
         * offline: the HTTP API and the sockets still serve. Tests and a local
         * API-only session set it; production leaves the default.
         */
        TWITCH_BOT_ENABLED: key(
            {
                kind: 'plain',
                description:
                    '"false" keeps the chat bot, drops and channel-point reward handling offline; the HTTP API and the sockets still serve.',
                default: 'true',
            },
            flag('true'),
        ),
        // modules/twitch/eventsub.service.ts
        /**
         * `true` mounts Twurple's EventSub webhook middleware on `/twitch/*`
         * (the old main.ts did this whenever NODE_ENV was production) and
         * subscribes to channel-point redemptions and raids once the server
         * listens. Twitch must reach `https://$DOMAIN/twitch/…` on port 443, so
         * development leaves it off and runs without EventSub.
         */
        TWITCH_EVENTSUB_ENABLED: key(
            {
                kind: 'plain',
                description:
                    '"true" mounts the EventSub webhook on /twitch/* and subscribes to channel-point redemptions and raids. Twitch must reach https://$DOMAIN/twitch/… on 443, so development leaves it off.',
                default: 'false',
            },
            flag('false'),
        ),

        // Integrations (optional: absent disables the feature)

        // read by nothing yet
        RIOT_API_KEY: key(
            {
                kind: 'secret',
                description: 'Riot Games API key. Nothing reads it yet. Unset or blank = absent.',
            },
            optionalString(),
        ),
        // modules/twitch/fun/chess.service.ts
        LICHESS_AUTH_TOKEN: key(
            {
                kind: 'secret',
                description:
                    'Lichess API token sent with the !chess open challenge. Unset or blank → the challenge is created anonymously.',
            },
            optionalString(),
        ),
        // modules/twitch/fun/ai-reply.service.ts
        OPEN_API_KEY: key(
            {
                kind: 'secret',
                description: 'OpenAI API key behind the @bot chat reply. Unset or blank → the bot does not reply.',
            },
            optionalString(),
        ),
        // modules/twitch/fun/ai-reply.service.ts
        /** Chat model behind the `@bot` reply; only read when OPEN_API_KEY is set. */
        OPENAI_MODEL: key(
            {
                kind: 'plain',
                description: 'OpenAI chat model behind the @bot reply. Read only when OPEN_API_KEY is set.',
                default: 'gpt-4o-mini',
            },
            z.string().min(1).default('gpt-4o-mini'),
        ),
        // read by nothing yet
        STREAMLABS_CLIENT_ID: key(
            {
                kind: 'plain',
                description: 'Streamlabs application client id. Nothing reads it yet. Unset or blank = absent.',
            },
            optionalString(),
        ),
        // read by nothing yet
        STREAMLABS_SECRET: key(
            {
                kind: 'secret',
                description: 'Streamlabs application client secret. Nothing reads it yet. Unset or blank = absent.',
            },
            optionalString(),
        ),
        // read by nothing yet
        STREAMLABS_REDIRECT_URI: key(
            {
                kind: 'plain',
                description: 'Streamlabs OAuth redirect URI. Nothing reads it yet. Unset or blank = absent.',
            },
            optionalString(),
        ),
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
export type EnvKey = keyof Env;

export const ENV_KEYS = Object.keys(envSchema.shape) as EnvKey[];

export function envKeyMeta(name: EnvKey): EnvKeyMeta {
    const meta = envRegistry.get(envSchema.shape[name]);
    if (!meta) throw new Error(`env schema: ${name} has no metadata`);
    return meta;
}

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
