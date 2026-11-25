/**
 * `/auth/twitch/*` and the `/auth/refresh` alias (`modules/auth/auth.controller.ts`).
 *
 * The three start routes redirect to Twitch. Their callbacks redirect back to
 * `UI_URL`, with `?auth_error=<reason>` on a failure, unless the client asked
 * for JSON (`Accept: application/json`), in which case they answer directly.
 * Cookies are set either way.
 */
import { defineRoute, doc } from '@singularity/http-contract';
import type { RouteResponse } from '@singularity/http-contract';
import { z } from 'zod';
import { BrobotError, tooManyRequests, unauthorized, validationFailed } from './common';
import { userSession } from './security';

// ── schemas ─────────────────────────────────────────────────────────────────

/** The same shape api-time's `AuthService.generateTokenPair` returns, so libs/kit/ngx-auth works unchanged. */
export const BrobotTokenPair = z
    .strictObject({
        accessToken: z.string().meta({ description: 'Access JWT, 15 minutes' }),
        refreshToken: z.string().meta({ description: 'Refresh JWT, 7 days' }),
    })
    .meta({ id: 'BrobotTokenPair', description: "brobot's JWT pair (`TokenPair`)." });

export const BrobotRefreshRequest = z
    .strictObject({
        refreshToken: z
            .string()
            .min(1)
            .max(4096)
            .optional()
            .meta({
                description:
                    'Bearer mode: the refresh token. Absent: the `refreshToken` cookie is used (cookie mode).',
            }),
    })
    .meta({
        id: 'BrobotRefreshRequest',
        description: 'A refresh, in bearer mode (token in the body) or cookie mode (`{}`).',
    });

export const BrobotCurrentUserStatus = z
    .strictObject({
        oauthId: z.string().meta({ description: 'Twitch user id' }),
        displayName: z.string(),
        roles: z
            .array(z.string())
            .meta({ description: '`twitch_user.roles`: `StreamerAuth`, `BotAuth`, `Admin`, …' }),
        profileImageUrl: z.string().nullable(),
        scope: z
            .array(z.string())
            .meta({ description: 'The Twitch scopes granted at sign-in; empty before the first' }),
    })
    .meta({
        id: 'BrobotCurrentUserStatus',
        description: 'The signed-in user (`CurrentUserStatus`).',
    });

export const BrobotLinkedAccount = z
    .strictObject({
        linked: z
            .enum(['streamer', 'bot'])
            .meta({ description: "The account whose Twitch token was stored: the route's own" }),
    })
    .meta({ id: 'BrobotLinkedAccount', description: 'A streamer or bot token link succeeded.' });

/** Descriptions joined as paragraphs (a multi-line `doc` cannot be interpolated into another). */
const paragraphs = (...parts: string[]): string =>
    `${parts.map(part => part.trimEnd()).join('\n\n')}\n`;

/** Why a callback failed; the redirect's `auth_error`, and the JSON error's `message`. */
const AUTH_ERROR_REASONS = doc`
    The reason is one of \`access_denied\` (the user refused on Twitch),
    \`invalid_state\` (state cookie missing or not matching, no code, or a code
    Twitch would not exchange), \`wrong_account\` (a streamer or bot link by
    another account) and \`twitch_unavailable\` (Twitch, or brobot, failed).
`;

const callbackQuery = () =>
    z.object({
        code: z.string().min(1).optional().meta({ description: "Twitch's authorization code" }),
        state: z
            .string()
            .min(1)
            .optional()
            .meta({ description: "Must equal the flow's state cookie (`brobot_oauth_<flow>`)" }),
        error: z.string().optional().meta({ description: 'Set by Twitch when the user refused' }),
    });

// ── shared responses ────────────────────────────────────────────────────────

const location = (description: string) => z.object({ Location: z.string().meta({ description }) });

const toTwitch = {
    description: doc`
        To Twitch's authorize page for this flow, with a fresh \`state\`. The
        state is also set as the httpOnly \`brobot_oauth_<flow>\` cookie the
        callback checks.
    `,
    headers: location("Twitch's authorize URL"),
} as const satisfies RouteResponse;

const callbackRedirect = (success: string) =>
    ({
        description: doc`
            A browser (no \`Accept: application/json\`): back to \`UI_URL\`.
            ${success} On a failure, \`?auth_error=<reason>\`.
        `,
        headers: location('`UI_URL`, with the outcome in the query'),
    } as const satisfies RouteResponse);

const callbackFailures = {
    401: { description: 'JSON only: `access_denied` or `invalid_state`', body: BrobotError },
    403: {
        description: 'JSON only: `wrong_account` (the streamer and bot links)',
        body: BrobotError,
    },
    502: { description: 'JSON only: `twitch_unavailable`', body: BrobotError },
} as const satisfies Record<string, RouteResponse>;

const refreshResponses = {
    200: {
        description: doc`
            Bearer mode (a \`refreshToken\` in the body): the new pair. Cookie
            mode (the \`refreshToken\` cookie) answers \`200\` with an empty
            body and sets new \`accessToken\` and \`refreshToken\` cookies, so a
            page script never sees a token.
        `,
        body: BrobotTokenPair,
    },
    400: validationFailed,
    401: {
        description:
            'No refresh token, or one that is invalid or expired (the cookies are cleared)',
        body: BrobotError,
    },
    429: tooManyRequests,
} as const satisfies Record<string, RouteResponse>;

const refreshDescription = doc`
    Same contract as api-time's \`POST /api/auth/refresh\`. A refresh token in
    the body (bearer mode) gets the new pair back in the body; one from the
    \`refreshToken\` cookie (web) gets new cookies and an empty \`200\`.
`;

// ── viewer ──────────────────────────────────────────────────────────────────

export const twitchLogin = defineRoute({
    operationId: 'twitchLogin',
    method: 'get',
    path: '/auth/twitch/login',
    tags: ['Auth'],
    summary: 'Start the viewer sign-in',
    description: doc`
        A browser navigation, never a fetch: sets a fresh \`state\` as the
        \`brobot_oauth_viewer\` cookie (10 minutes) and redirects to Twitch,
        which sends the browser on to \`/auth/twitch/callback\`.
    `,
    responses: { 302: toTwitch, 429: tooManyRequests },
});

export const twitchCallback = defineRoute({
    operationId: 'twitchCallback',
    method: 'get',
    path: '/auth/twitch/callback',
    tags: ['Auth'],
    summary: 'Viewer sign-in callback',
    description: paragraphs(
        doc`
        Exchanges the code, upserts the user and issues brobot's JWT pair, set
        as the \`accessToken\` and \`refreshToken\` cookies.
    `,
        AUTH_ERROR_REASONS,
    ),
    query: callbackQuery(),
    responses: {
        200: {
            description:
                '`Accept: application/json`: signed in; the pair is in the body and the cookies',
            body: BrobotTokenPair,
        },
        302: callbackRedirect('Signed in: `UI_URL` as it is.'),
        400: validationFailed,
        ...callbackFailures,
        429: tooManyRequests,
    },
});

// ── streamer / bot token links ──────────────────────────────────────────────

export const twitchStreamerLink = defineRoute({
    operationId: 'twitchStreamerLink',
    method: 'get',
    path: '/auth/twitch/streamer',
    tags: ['Auth'],
    summary: "Start linking the streamer's Twitch token",
    description: doc`
        A browser navigation, never a fetch: sets a fresh \`state\` as the
        \`brobot_oauth_streamer\` cookie (10 minutes) and redirects to Twitch
        with \`force_verify\`, so the account is chosen rather than reused.
        Twitch sends the browser on to \`/auth/twitch/streamer/callback\`.
    `,
    responses: { 302: toTwitch, 429: tooManyRequests },
});

export const twitchStreamerCallback = defineRoute({
    operationId: 'twitchStreamerCallback',
    method: 'get',
    path: '/auth/twitch/streamer/callback',
    tags: ['Auth'],
    summary: 'Streamer token link callback',
    description: paragraphs(
        doc`
        Stores the streamer's Twitch token. Only \`TWITCH_STREAMER_OAUTH_ID\`
        is accepted; the caller's own session is never touched.
    `,
        AUTH_ERROR_REASONS,
    ),
    query: callbackQuery(),
    responses: {
        200: { description: '`Accept: application/json`: linked', body: BrobotLinkedAccount },
        302: callbackRedirect('Linked: `?linked=streamer`.'),
        400: validationFailed,
        ...callbackFailures,
        429: tooManyRequests,
    },
});

export const twitchBotLink = defineRoute({
    operationId: 'twitchBotLink',
    method: 'get',
    path: '/auth/twitch/bot',
    tags: ['Auth'],
    summary: "Start linking the bot's Twitch token",
    description: doc`
        A browser navigation, never a fetch: sets a fresh \`state\` as the
        \`brobot_oauth_bot\` cookie (10 minutes) and redirects to Twitch with
        \`force_verify\`, so the account is chosen rather than reused. Twitch
        sends the browser on to \`/auth/twitch/bot/callback\`.
    `,
    responses: { 302: toTwitch, 429: tooManyRequests },
});

export const twitchBotCallback = defineRoute({
    operationId: 'twitchBotCallback',
    method: 'get',
    path: '/auth/twitch/bot/callback',
    tags: ['Auth'],
    summary: 'Bot token link callback',
    description: paragraphs(
        doc`
        Stores the bot's Twitch token. Only \`TWITCH_BOT_OAUTH_ID\` is
        accepted; the caller's own session is never touched.
    `,
        AUTH_ERROR_REASONS,
    ),
    query: callbackQuery(),
    responses: {
        200: { description: '`Accept: application/json`: linked', body: BrobotLinkedAccount },
        302: callbackRedirect('Linked: `?linked=bot`.'),
        400: validationFailed,
        ...callbackFailures,
        429: tooManyRequests,
    },
});

// ── session ─────────────────────────────────────────────────────────────────

export const getAuthStatus = defineRoute({
    operationId: 'getAuthStatus',
    method: 'get',
    path: '/auth/twitch/status',
    tags: ['Auth'],
    security: userSession,
    summary: 'The signed-in user',
    description:
        "The caller's Twitch identity, roles and granted scopes, read from the database on every call.",
    responses: {
        200: { description: 'The user', body: BrobotCurrentUserStatus },
        401: unauthorized,
        429: tooManyRequests,
    },
});

export const refreshTwitchSession = defineRoute({
    operationId: 'refreshTwitchSession',
    method: 'post',
    path: '/auth/twitch/refresh',
    tags: ['Auth'],
    summary: 'Refresh the session',
    description: refreshDescription,
    body: { schema: BrobotRefreshRequest.optional(), required: false },
    responses: refreshResponses,
});

export const logout = defineRoute({
    operationId: 'logout',
    method: 'post',
    path: '/auth/twitch/logout',
    tags: ['Auth'],
    summary: 'Sign out',
    description:
        'Stateless: clears the auth cookies. An access token already issued lives out its 15 minutes.',
    responses: { 204: { description: 'Signed out' }, 429: tooManyRequests },
});

export const refreshSession = defineRoute({
    operationId: 'refreshSession',
    method: 'post',
    path: '/auth/refresh',
    tags: ['Auth'],
    summary: 'Refresh the session (alias)',
    description: paragraphs(
        refreshDescription,
        doc`
        An alias of \`/auth/twitch/refresh\`, at the path libs/kit/ngx-auth's
        interceptor recognises, so a refresh that itself answers 401 is not
        retried through a refresh.
    `,
    ),
    body: { schema: BrobotRefreshRequest.optional(), required: false },
    responses: refreshResponses,
});

export const authRoutes = [
    twitchLogin,
    twitchCallback,
    twitchStreamerLink,
    twitchStreamerCallback,
    twitchBotLink,
    twitchBotCallback,
    getAuthStatus,
    refreshTwitchSession,
    logout,
    refreshSession,
] as const;
