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
 * channel or a role.
 */

export const DISCORD_ANNOUNCE_PATH = '/api/internal/announce';

/** Discord's limits on the embed fields the request fills. */
export const DISCORD_ANNOUNCE_LIMITS = { title: 256, body: 4096 } as const;

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
    /** `role` pings the project's `ping_role`. */
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

export type DiscordAnnounceResult =
    | { ok: true; status: number; response: DiscordAnnounceResponse }
    | { ok: false; status: number; error: string; message: string; retryable: boolean };

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
    const send: AnnounceFetch = options.fetch ?? fetch;
    const response = await send(`${options.baseUrl.replace(/\/+$/, '')}${DISCORD_ANNOUNCE_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (response.status === 200 || response.status === 201) {
        return { ok: true, status: response.status, response: body as DiscordAnnounceResponse };
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
