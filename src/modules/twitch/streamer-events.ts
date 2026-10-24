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

/** What a horror redemption does in the streamer's game (SLEEP TIGHT, friend-slop-1's horror mode). */
export const HORROR_EFFECTS = [
    'boo',
    'scream',
    'lights',
    'shout',
    'freeze',
    'press',
    'jumpscare',
    // chat plays (the game's !help / !mess / Night Shift's !door left|right): budgeted and capped by the game itself
    'help',
    'mess',
    'door left',
    'door right',
] as const;
export type HorrorEffect = (typeof HORROR_EFFECTS)[number];

/**
 * A viewer redeemed a horror reward: the client forwards it to the game running on the streamer's machine (one JSON
 * line to 127.0.0.1:47811). `shout` is the "hijack the mic" reward (the game hears a loud mic spike), `freeze` and
 * `press` take the streamer's controls for a moment, inside the game only.
 */
export interface HorrorEvent {
    type: 'horror';
    effect: HorrorEffect;
    /** The redeemer's display name, for the game's on-screen ticker. */
    user: string;
}

/**
 * A chat line from the channel, for the horror game (SLEEP TIGHT `rehearsal` and `live` modes only). The client hands it
 * to the game as `{"type":"chat","user":...,"text":...}`, and the game reads it exactly like a line it read from chat.
 */
export interface HorrorChatEvent {
    type: 'horror_chat';
    user: string;
    text: string;
}

export type StreamerServerEvent = ChatbanEvent | VoicebanEvent | PingEvent | HorrorEvent | HorrorChatEvent;

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

/**
 * The horror game on the streamer's machine told the client whether a SLEEP TIGHT run is being played (`live`), and
 * which dream is on. The client sends it when the game says so, when the game connects or goes away (`live: false`),
 * and the game repeats it every 30 s while a run is on. brobot shows the horror rewards only while `live` is true.
 */
export interface HorrorRunEvent {
    type: 'horror_run';
    live: boolean;
    /** The dream being played ("Night Shift"), empty between dreams or when not live. */
    dream?: string;
}

/**
 * The horror game showed a dream's preview (ready-check) screen. In `live` mode brobot posts that dream's rules line to
 * chat (rate-limited); in any other mode it posts nothing.
 */
export interface HorrorPreviewEvent {
    type: 'horror_preview';
    /** The game's dream id ("freddy"). */
    dream: string;
    /** The dream's title as the game shows it ("Night Shift"), when sent. */
    name?: string;
}

export type StreamerClientEvent = BanCompleteEvent | PongEvent | HorrorRunEvent | HorrorPreviewEvent;

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
        case 'horror_run':
            if (typeof record.live !== 'boolean') return null;
            return typeof record.dream === 'string' && record.dream.length > 0
                ? { type: 'horror_run', live: record.live, dream: record.dream.slice(0, 64) }
                : { type: 'horror_run', live: record.live };
        case 'horror_preview':
            if (typeof record.dream !== 'string' || record.dream.length === 0) return null;
            return typeof record.name === 'string' && record.name.length > 0
                ? { type: 'horror_preview', dream: record.dream.slice(0, 32), name: record.name.slice(0, 64) }
                : { type: 'horror_preview', dream: record.dream.slice(0, 32) };
        default:
            return null;
    }
}
