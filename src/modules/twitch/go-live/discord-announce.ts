/**
 * The discord-bot's announce endpoint, `POST /api/internal/announce`: the
 * part of its wire brobot sends. The authority is singularity's
 * `libs/contracts/src/discord-announce.ts` (and the bot's own schema); brobot
 * imports no workspace library, so it keeps this copy, and a change there
 * that touches these fields is a change here too.
 *
 * The caller names a server, a project and a kind; the bot's
 * `servers/<slug>.yaml` (`announce.projects.brobot`) picks the channel, the
 * embed's colour and the role `ping: 'role'` reaches. brobot never names a
 * channel or a role, and never asks for the ping: that is an opt-in for an
 * emergency (an outage, a security notice; owner, 2026-10-19). An edit
 * (`/announce/edit`) addresses the post by the server and the idempotency key
 * it was posted under, so brobot keeps no message ids. A scheduled-events
 * sync (`/announce/events`) sets the Discord Scheduled Events of one source,
 * the streamer's Twitch schedule, from the whole list.
 */

export const DISCORD_ANNOUNCE_PATH = '/api/internal/announce';
export const DISCORD_ANNOUNCE_EDIT_PATH = '/api/internal/announce/edit';
export const DISCORD_ANNOUNCE_EVENTS_PATH = '/api/internal/announce/events';

/** Discord's limits on the embed fields the request fills. */
export const DISCORD_ANNOUNCE_LIMITS = { title: 256, body: 4096 } as const;

/** The bot's limits on a scheduled-events sync. */
export const DISCORD_EVENTS_LIMITS = {
    /** Events in one request. */
    count: 25,
    name: 100,
    /** Discord allows 1000; the bot keeps room for its reference line. */
    description: 900,
    location: 100,
} as const;

export interface DiscordAnnounceRequest {
    /** The server's slug (`home`). */
    server: string;
    /** The project key under that server's `announce.projects`. */
    project: 'brobot';
    kind: 'stream-live';
    title: string;
    /** Discord markdown. */
    body: string;
    /** The link the title opens. */
    url?: string;
    /** A public https image under the text. */
    image?: string;
    /** `none` (the default) pings nobody; `role` pings the project's `ping_role`, for an emergency only. */
    ping?: 'role' | 'none';
    /** Stable across retries: the bot posts once per key. Printable ASCII, no spaces, ≤ 200 characters. */
    idempotency_key: string;
}

export interface DiscordAnnounceResponse {
    duplicate: boolean;
    message_id: string;
    message_url: string;
    channel_id: string;
    crossposted: boolean;
    crosspost_error?: string;
}

/**
 * What to change in the post made under `idempotency_key`: a field left out
 * stays as posted; `null` removes the image. The bot remembers a key for 24
 * hours, and not across its own restart (then 404 `unknown_post`).
 */
export interface DiscordAnnounceEditRequest {
    server: string;
    idempotency_key: string;
    title?: string;
    body?: string;
    url?: string | null;
    image?: string | null;
    /** Replaces the kind in the footer (`Live now` → `Was live`), ≤ 64 characters. */
    label?: string;
}

export interface DiscordAnnounceEditResponse {
    message_id: string;
    message_url: string;
    channel_id: string;
}

/**
 * The whole set of upcoming events for one `source` in `server`. The list is
 * authoritative: the bot creates what is missing, updates what changed, and
 * deletes its own events of that source that have not started and are not
 * listed. An empty list deletes them all, so a failed read sends nothing.
 * The project's `announce.projects` entry must opt in to events, or the bot
 * answers 422 `no_route`.
 */
export interface DiscordScheduledEventsRequest {
    server: string;
    project: 'brobot';
    /** Whose events these are (`twitch:<broadcaster_id>`): the deletion scope. ≤ 100 characters. */
    source: string;
    /** At most 25, with unique keys. */
    events: DiscordScheduledEvent[];
}

/** One Discord Scheduled Event (an external one, at `location`). */
export interface DiscordScheduledEvent {
    /** Stable across syncs, unique in the request (`twitch:segment:<id>`). Printable ASCII, no spaces, ≤ 200 characters. */
    key: string;
    /** ≤ 100 characters. */
    name: string;
    /** ≤ 900 characters. */
    description?: string;
    /** A URL or a place, ≤ 100 characters. */
    location: string;
    /** ISO-8601. */
    start: string;
    /** ISO-8601, after `start`. */
    end: string;
    /** A public https cover image. */
    image?: string;
}

export interface DiscordScheduledEventsResponse {
    events: {
        key: string;
        event_id: string;
        event_url: string;
        outcome: 'created' | 'updated' | 'unchanged';
    }[];
    deleted: { key: string; event_id: string }[];
}

type Result<T> =
    | { ok: true; status: number; response: T }
    | { ok: false; status: number; error: string; message: string; retryable: boolean };

export type DiscordAnnounceResult = Result<DiscordAnnounceResponse>;
export type DiscordAnnounceEditResult = Result<DiscordAnnounceEditResponse>;
export type DiscordScheduledEventsResult = Result<DiscordScheduledEventsResponse>;

/** A refused or unreachable call to the bot. */
export type DiscordAnnounceFailure = Extract<Result<never>, { ok: false }>;

/** The part of `fetch` the client uses; tests pass their own. */
export type AnnounceFetch = (
    url: string,
    init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface DiscordAnnounceClientOptions {
    /** The bot's origin, without `/api`. */
    baseUrl: string;
    /** The bot's `INTERNAL_API_TOKEN`. */
    token: string;
    fetch?: AnnounceFetch;
}

/**
 * Posts one announcement and resolves with the bot's answer whatever the
 * status. Only a 5xx is worth retrying (with the same `idempotency_key`); a
 * 4xx is the request or the bot's configuration. Rejects only when the bot
 * could not be reached, which is as retryable as a 503.
 */
export async function postDiscordAnnouncement(
    request: DiscordAnnounceRequest,
    options: DiscordAnnounceClientOptions,
): Promise<DiscordAnnounceResult> {
    return call(DISCORD_ANNOUNCE_PATH, request, options);
}

/**
 * Edits the post made under `request.idempotency_key`, answering as
 * {@link postDiscordAnnouncement} does. An edit sets fields, so a retry is
 * safe; a 404 `unknown_post` is final.
 */
export async function editDiscordAnnouncement(
    request: DiscordAnnounceEditRequest,
    options: DiscordAnnounceClientOptions,
): Promise<DiscordAnnounceEditResult> {
    return call(DISCORD_ANNOUNCE_EDIT_PATH, request, options);
}

/**
 * Sets the scheduled events of `request.source`, answering as
 * {@link postDiscordAnnouncement} does. A sync sets state, so a retry is safe.
 */
export async function syncDiscordScheduledEvents(
    request: DiscordScheduledEventsRequest,
    options: DiscordAnnounceClientOptions,
): Promise<DiscordScheduledEventsResult> {
    return call(DISCORD_ANNOUNCE_EVENTS_PATH, request, options);
}

/** Where {@link sendWithRetries} logs. */
interface RetryLogger {
    warn(message: string): void;
    error(message: string): void;
}

/**
 * Sends until the bot answers, retrying a 5xx or an unreachable bot after
 * each of `delays`; logs a failure (with `hint`'s explanation, if any), and
 * returns the last answer.
 */
export async function sendWithRetries<T extends { ok: true } | DiscordAnnounceFailure>(
    what: string,
    send: () => Promise<T>,
    options: {
        delays: readonly number[];
        logger: RetryLogger;
        hint?: (failure: DiscordAnnounceFailure) => string | undefined;
    },
): Promise<T | DiscordAnnounceFailure> {
    const { delays, logger, hint } = options;
    for (let attempt = 0; ; attempt++) {
        const result: T | DiscordAnnounceFailure = await send().catch(
            (error: unknown): DiscordAnnounceFailure => ({
                ok: false,
                status: 0,
                error: 'unreachable',
                message: error instanceof Error ? error.message : String(error),
                retryable: true,
            }),
        );
        if (result.ok) return result;
        if (!result.retryable || attempt >= delays.length) {
            const why = hint?.(result);
            logger.error(
                `${what} failed${result.retryable ? ` after ${attempt + 1} attempts` : ''}: ` +
                    `${result.status} ${result.error}: ${result.message}` +
                    (why ? ` (${why})` : ''),
            );
            return result;
        }
        const delay = delays[attempt];
        logger.warn(`${what}: ${result.status} ${result.error}, retrying in ${delay / 1000}s`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}

async function call<T>(
    path: string,
    request: DiscordAnnounceRequest | DiscordAnnounceEditRequest | DiscordScheduledEventsRequest,
    options: DiscordAnnounceClientOptions,
): Promise<Result<T>> {
    const send: AnnounceFetch = options.fetch ?? fetch;
    const response = await send(`${options.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (response.status === 200 || response.status === 201) {
        return { ok: true, status: response.status, response: body as T };
    }
    // A proxy's own error page is not the bot's `{ error, message }`.
    const known = isAnnounceError(body);
    return {
        ok: false,
        status: response.status,
        error: known ? body.error : 'http_error',
        message: known ? body.message : `HTTP ${response.status}`,
        retryable: response.status >= 500,
    };
}

function isAnnounceError(body: unknown): body is { error: string; message: string } {
    return (
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { error?: unknown }).error === 'string' &&
        typeof (body as { message?: unknown }).message === 'string'
    );
}
