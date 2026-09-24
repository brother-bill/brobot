/**
 * The `/api/ashketchum` wire contract between brobot and the streamer client.
 *
 * The rebuilt client (ticket C1, apps/brobot-client) imports this file BY
 * COPY: it must stay self-contained — no imports, no runtime dependencies —
 * and a change here is a change to that copy too.
 *
 * Transport: one WebSocket at `wss://<api host>/api/ashketchum`. The upgrade
 * carries `WS_SECRET`, as `Authorization: Bearer <secret>` (or, for the 2022
 * client, a `token: <secret>` header); anything else is refused with HTTP 401
 * before a socket exists. Every frame is one JSON object with a `type`.
 * Unknown types are ignored by both sides, so either can add one first.
 *
 * The 2022 client spoke Nest's `{ event, data }` frames; this contract
 * replaces them.
 */

export const STREAMER_SOCKET_PATH = '/api/ashketchum';

/** How long each ban lasts. The chat copy promises these numbers. */
export const CHATBAN_DURATION_MS = 5 * 60 * 1000;
export const VOICEBAN_DURATION_MS = 30 * 1000;

// ── brobot → client ──────────────────────────────────────────────────────

/** Enough viewers voted `!chatban`: block the streamer's Enter key for `durationMs`. */
export interface ChatbanEvent {
    type: 'chatban';
    durationMs: number;
}

/** Enough viewers voted `!voiceban`: mute the streamer's microphone for `durationMs`. */
export interface VoicebanEvent {
    type: 'voiceban';
    durationMs: number;
}

/**
 * Sent every 15 s. Answering with {@link PongEvent} is optional — the socket's
 * own ping/pong frames keep the connection alive — but lets a client measure
 * latency and notice a dead server without relying on protocol pings.
 */
export interface PingEvent {
    type: 'ping';
    /** `Date.now()` on the server. */
    sentAt: number;
}

export type StreamerServerEvent = ChatbanEvent | VoicebanEvent | PingEvent;

// ── client → brobot ──────────────────────────────────────────────────────

/**
 * The ban is over (or could not be applied). brobot resets that vote and
 * tells chat the streamer is free; with `error` it first says something broke.
 */
export interface BanCompleteEvent {
    type: 'chatban_complete' | 'voiceban_complete';
    error?: string;
}

/** Reply to {@link PingEvent}, echoing its `sentAt`. */
export interface PongEvent {
    type: 'pong';
    sentAt: number;
}

export type StreamerClientEvent = BanCompleteEvent | PongEvent;

/** Parses one frame from the client; null for anything malformed or unknown. */
export function parseStreamerClientEvent(frame: string): StreamerClientEvent | null {
    let value: unknown;
    try {
        value = JSON.parse(frame);
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    switch (record.type) {
        case 'chatban_complete':
        case 'voiceban_complete':
            return typeof record.error === 'string' && record.error.length > 0
                ? { type: record.type, error: record.error }
                : { type: record.type };
        case 'pong':
            return typeof record.sentAt === 'number' ? { type: 'pong', sentAt: record.sentAt } : null;
        default:
            return null;
    }
}
