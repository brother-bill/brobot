import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from '../../../config/env.service';
import {
    type AnnounceFetch,
    type DiscordAnnounceEditRequest,
    type DiscordAnnounceRequest,
    DISCORD_ANNOUNCE_LIMITS,
    editDiscordAnnouncement,
    postDiscordAnnouncement,
} from './discord-announce';

/** What EventSub's `stream.online` says, plus the stream's type (only `live` is announced). */
export interface StreamOnline {
    /** Twitch's id for this broadcast: one announcement per id. */
    streamId: string;
    type: string;
    broadcasterId: string;
    login: string;
    displayName: string;
    /** When the broadcast started: the "was live" edit says for how long. */
    startedAt: Date;
}

/** The channel's title and category, from Helix: `stream.online` carries neither. */
export interface ChannelInfo {
    title: string;
    gameName: string;
}

/**
 * Waits between attempts after a retryable failure (the bot reconnecting to
 * Discord, a deploy restarting it): about four minutes in all, which still
 * reads as "just went live".
 */
export const GO_LIVE_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 180_000] as const;

/** The footer's label once the stream has ended, in place of the kind's `Live now`. */
export const WAS_LIVE_LABEL = 'Was live';

/** A broadcast on air: what its go-live post said, for the edit when it ends. */
interface OnAir {
    readonly stream: StreamOnline;
    /** Settles once the go-live post is in, or has been given up. */
    readonly announced: Promise<{ info: ChannelInfo | null; posted: boolean }>;
}

/** A refused or unreachable call to the bot. */
interface Failure {
    ok: false;
    status: number;
    error: string;
    message: string;
    retryable: boolean;
}

/**
 * Announces the streamer going live in the Discord, through the discord-bot's
 * announce endpoint: the stream's title, its category, the preview image and
 * a link, pinging the role `announce.projects.brobot.ping_role` names in the
 * bot's server file. The channel is the bot's choice too
 * (`kinds.stream-live`). When the stream ends (`stream.offline`), it edits
 * that post to say the stream was live, and for how long, addressing it by
 * the same idempotency key.
 *
 * Off unless `DISCORD_BOT_URL` (and so `DISCORD_INTERNAL_API_TOKEN`) is set.
 * Twitch retries a webhook delivery, and this retries the bot, both with the
 * same idempotency key, so a broadcast is announced once.
 *
 * What is on air is held in memory. A broadcast brobot started up during is
 * found through Helix at startup ({@link resume}), so its end is still
 * marked; one that started and ended while brobot was down is not.
 */
@Injectable()
export class GoLiveService {
    private readonly logger = new Logger(GoLiveService.name);
    /** By broadcaster id. */
    private readonly onAir = new Map<string, OnAir>();
    /** Tests replace it; production uses the global `fetch`. */
    fetch: AnnounceFetch | undefined;

    constructor(private readonly env: EnvService) {}

    get enabled(): boolean {
        return Boolean(
            this.env.get('DISCORD_BOT_URL') && this.env.get('DISCORD_INTERNAL_API_TOKEN'),
        );
    }

    /**
     * Posts the announcement, retrying a 5xx or an unreachable bot. Never
     * throws: a failure is logged, and the stream goes on without it.
     * `channel` is asked once; when Helix fails, the announcement goes out
     * without the title and category rather than not at all.
     */
    async streamOnline(
        stream: StreamOnline,
        channel: () => Promise<ChannelInfo | null>,
    ): Promise<void> {
        if (!this.enabled) return;
        if (stream.type !== 'live') {
            this.logger.log(`Stream ${stream.streamId} is a ${stream.type}, not announced`);
            return;
        }
        const announced = this.announce(stream, channel);
        this.onAir.set(stream.broadcasterId, { stream, announced });
        await announced;
    }

    /**
     * Remembers a broadcast already on air when brobot starts, so its end is
     * marked on the post its go-live made. It is not announced again.
     */
    resume(stream: StreamOnline, info: ChannelInfo | null): void {
        if (!this.enabled || stream.type !== 'live' || this.onAir.has(stream.broadcasterId)) return;
        this.onAir.set(stream.broadcasterId, {
            stream,
            announced: Promise.resolve({ info, posted: true }),
        });
        this.logger.log(
            `Stream ${stream.streamId} is on air: its end will be marked on its go-live post`,
        );
    }

    /**
     * Edits the broadcast's go-live post to say it was live, once that post
     * is in. Never throws, and retries as {@link streamOnline} does.
     */
    async streamOffline(broadcasterId: string): Promise<void> {
        if (!this.enabled) return;
        const onAir = this.onAir.get(broadcasterId);
        if (!onAir) {
            this.logger.log(
                'Stream ended with no go-live post to mark (brobot was not running when it started)',
            );
            return;
        }
        this.onAir.delete(broadcasterId);
        const { info, posted } = await onAir.announced;
        if (!posted) return;
        const edit = wasLiveEdit(
            onAir.stream,
            info,
            this.env.get('DISCORD_ANNOUNCE_SERVER'),
            new Date(),
        );
        const result = await this.retrying('"Was live" edit', () =>
            editDiscordAnnouncement(edit, this.options()),
        );
        if (result.ok)
            this.logger.log(`Go-live post marked "was live": ${result.response.message_url}`);
    }

    private async announce(
        stream: StreamOnline,
        channel: () => Promise<ChannelInfo | null>,
    ): Promise<{ info: ChannelInfo | null; posted: boolean }> {
        const info = await channel().catch((error: unknown) => {
            this.logger.warn(
                `Channel info for the go-live announcement failed: ${describe(error)}`,
            );
            return null;
        });
        const request = goLiveAnnouncement(stream, info, this.env.get('DISCORD_ANNOUNCE_SERVER'));
        const result = await this.retrying('Go-live announcement', () =>
            postDiscordAnnouncement(request, this.options()),
        );
        if (result.ok) {
            const { response } = result;
            this.logger.log(
                `Go-live ${response.duplicate ? 'already announced' : 'announced'}: ${
                    response.message_url
                }` +
                    (response.crosspost_error
                        ? ` (not published: ${response.crosspost_error})`
                        : ''),
            );
        }
        return { info, posted: result.ok };
    }

    /**
     * Sends until the bot answers, retrying a 5xx or an unreachable bot after
     * each of {@link GO_LIVE_RETRY_DELAYS_MS}; logs a failure, and returns the
     * last answer.
     */
    private async retrying<T extends { ok: true } | Failure>(
        what: string,
        send: () => Promise<T>,
    ): Promise<T | Failure> {
        for (let attempt = 0; ; attempt++) {
            const result: T | Failure = await send().catch(
                (error: unknown): Failure => ({
                    ok: false,
                    status: 0,
                    error: 'unreachable',
                    message: describe(error),
                    retryable: true,
                }),
            );
            if (result.ok) return result;
            if (!result.retryable || attempt >= GO_LIVE_RETRY_DELAYS_MS.length) {
                this.logger.error(
                    `${what} failed${result.retryable ? ` after ${attempt + 1} attempts` : ''}: ` +
                        `${result.status} ${result.error}: ${result.message}`,
                );
                return result;
            }
            const delay = GO_LIVE_RETRY_DELAYS_MS[attempt];
            this.logger.warn(
                `${what}: ${result.status} ${result.error}, retrying in ${delay / 1000}s`,
            );
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    private options() {
        return {
            baseUrl: this.env.get('DISCORD_BOT_URL') ?? '',
            token: this.env.get('DISCORD_INTERNAL_API_TOKEN') ?? '',
            fetch: this.fetch,
        };
    }
}

/** The announcement for one broadcast. Exported for the spec. */
export function goLiveAnnouncement(
    stream: StreamOnline,
    info: ChannelInfo | null,
    server: string,
): DiscordAnnounceRequest {
    const url = `https://www.twitch.tv/${stream.login}`;
    const title = info?.title.trim();
    const game = info?.gameName.trim();
    return {
        server,
        project: 'brobot',
        kind: 'stream-live',
        title: clip(
            title
                ? `${stream.displayName} is live: ${title}`
                : `${stream.displayName} is live on Twitch`,
            DISCORD_ANNOUNCE_LIMITS.title,
        ),
        body: clip(
            `${
                game ? `Playing **${escapeMarkdown(game)}**` : 'Live now'
            } on Twitch.\n[Watch the stream](${url})`,
            DISCORD_ANNOUNCE_LIMITS.body,
        ),
        url,
        // Twitch's live preview. Discord caches an image by its URL, so the
        // stream id keeps one broadcast's preview from showing on the next.
        image: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${stream.login}-1280x720.jpg?stream=${stream.streamId}`,
        ping: 'role',
        idempotency_key: goLiveKey(stream),
    };
}

/**
 * The edit that marks a broadcast's go-live post once it has ended: "was
 * live", what was streamed and for how long, a link to the past broadcasts,
 * and no preview image (it would show the stream as it was). Exported for
 * the spec.
 */
export function wasLiveEdit(
    stream: StreamOnline,
    info: ChannelInfo | null,
    server: string,
    endedAt: Date,
): DiscordAnnounceEditRequest {
    const title = info?.title.trim();
    const game = info?.gameName.trim();
    const length = duration(endedAt.getTime() - stream.startedAt.getTime());
    const streamed = [game && `**${escapeMarkdown(game)}**`, length && `for ${length}`]
        .filter(Boolean)
        .join(' ');
    return {
        server,
        idempotency_key: goLiveKey(stream),
        title: clip(
            title
                ? `${stream.displayName} was live: ${title}`
                : `${stream.displayName} was live on Twitch`,
            DISCORD_ANNOUNCE_LIMITS.title,
        ),
        body: clip(
            `${streamed ? `Streamed ${streamed}.` : 'The stream has ended.'}\n` +
                `[Past broadcasts](https://www.twitch.tv/${stream.login}/videos)`,
            DISCORD_ANNOUNCE_LIMITS.body,
        ),
        image: null,
        label: WAS_LIVE_LABEL,
    };
}

/** The key a broadcast's go-live post is made, and later edited, under. */
function goLiveKey(stream: StreamOnline): string {
    return `twitch:stream-live:${stream.broadcasterId}:${stream.streamId}`;
}

/** `2 h 14 min`, `3 h`, `45 min`; nothing under a minute. */
function duration(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 1) return '';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return [hours && `${hours} h`, rest && `${rest} min`].filter(Boolean).join(' ');
}

function clip(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A category name is the streamer's text in the bot's markdown body: `*`, `_` and friends are literal. */
function escapeMarkdown(text: string): string {
    return text.replace(/[\\*_~`|>[\]()]/g, character => `\\${character}`);
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
