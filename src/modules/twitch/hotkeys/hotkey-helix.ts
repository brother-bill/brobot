import type { StreamerHotkey } from '../streamer-events';

/** The prediction `create_prediction` starts (TWITCH_PREDICTION_* in the env). */
export interface PredictionSpec {
    title: string;
    outcomes: string[];
    /** Helix `prediction_window`: Twitch locks the prediction after this many seconds. */
    windowSeconds: number;
}

/** The Helix calls behind the hotkeys, made as the streamer ({@link StreamerApiService} in production). */
export interface HotkeyHelix {
    createStreamMarker(): Promise<void>;
    createPrediction(spec: PredictionSpec): Promise<void>;
    startCommercial(lengthSeconds: 30): Promise<void>;
}

export const HOTKEY_HELIX = Symbol('HOTKEY_HELIX');

/** Thrown by a {@link HotkeyHelix} call while there is no streamer API client. */
export class StreamerOfflineError extends Error {
    constructor() {
        super('no streamer API client');
        this.name = 'StreamerOfflineError';
    }
}

const MAX_ERROR_LENGTH = 160;

/**
 * The line the streamer client shows when a hotkey failed: short, and about what the streamer can do. The Twitch
 * errors worth naming get their own wording; anything else is Twitch's own message.
 *
 * Twurple refuses a call whose stored token lacks the scope before sending it ("This token does not have any of the
 * requested scopes (…)"), and Helix answers a token without it with 401 "Missing scope: …"; both name the scope.
 */
export function hotkeyErrorText(hotkey: StreamerHotkey, error: unknown): string {
    if (error instanceof StreamerOfflineError) {
        return 'the streamer account is not linked, or the bot is switched off';
    }
    const status = httpStatus(error);
    // An HttpStatusCodeError's own message wraps Helix's in the status line and the URL: match Helix's alone.
    const message = status !== undefined ? (helixMessage(error) ?? '') : errorMessage(error);

    const scope = /requested scopes \(([^)]+)\)/.exec(message) ?? /missing scope:?\s*([\w:]+)/i.exec(message);
    if (scope) return `missing scope ${scope[1]}: link the streamer account again`;
    if (status === 401) return 'Twitch refused the streamer token: link the streamer account again';

    if (/not (currently )?(streaming|live)|must be (streaming )?live|is offline/i.test(message)) return 'not live';
    if (hotkey === 'create_marker' && status === 404) return 'not live';
    if (hotkey === 'create_prediction' && status === 400 && /already|active|running/i.test(message)) {
        return 'a prediction is already running';
    }
    if (hotkey === 'play_ad' && status === 429) return "a commercial ran too recently (Twitch's cooldown)";
    if (status === 429) return 'Twitch is rate-limiting the streamer account; try again in a minute';

    const line = message.split('\n')[0]?.trim() ?? '';
    let text = line || 'unknown error';
    if (status !== undefined) text = line ? `Twitch said ${status}: ${line}` : `Twitch answered HTTP ${status}`;
    return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

/** Twurple's HttpStatusCodeError carries `statusCode`; anything else has none. */
function httpStatus(error: unknown): number | undefined {
    const status = (error as { statusCode?: unknown } | null)?.statusCode;
    return typeof status === 'number' ? status : undefined;
}

/** Helix's `message` from an HttpStatusCodeError body (`{ error, status, message }`). */
function helixMessage(error: unknown): string | undefined {
    const body = (error as { body?: unknown } | null)?.body;
    if (typeof body !== 'string') return undefined;
    try {
        const parsed = JSON.parse(body) as { message?: unknown } | null;
        return typeof parsed?.message === 'string' && parsed.message.length > 0 ? parsed.message : undefined;
    } catch {
        return undefined;
    }
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : '';
}
