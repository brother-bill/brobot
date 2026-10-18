import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from '../../../config/env.service';
import {
    type AnnounceFetch,
    type DiscordAnnounceRequest,
    type DiscordAnnounceResult,
    DISCORD_ANNOUNCE_LIMITS,
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

/**
 * Announces the streamer going live in the Discord, through the discord-bot's
 * announce endpoint: the stream's title, its category, the preview image and
 * a link, pinging the role `announce.projects.brobot.ping_role` names in the
 * bot's server file. The channel is the bot's choice too
 * (`kinds.stream-live`).
 *
 * Off unless `DISCORD_BOT_URL` (and so `DISCORD_INTERNAL_API_TOKEN`) is set.
 * Twitch retries a webhook delivery, and this retries the bot, both with the
 * same idempotency key, so a broadcast is announced once.
 */
@Injectable()
export class GoLiveService {
    private readonly logger = new Logger(GoLiveService.name);
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
        const info = await channel().catch((error: unknown) => {
            this.logger.warn(
                `Channel info for the go-live announcement failed: ${describe(error)}`,
            );
            return null;
        });
        const request = goLiveAnnouncement(stream, info, this.env.get('DISCORD_ANNOUNCE_SERVER'));

        for (let attempt = 0; ; attempt++) {
            const result = await this.post(request);
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
                return;
            }
            if (!result.retryable || attempt >= GO_LIVE_RETRY_DELAYS_MS.length) {
                this.logger.error(
                    `Go-live announcement failed${
                        result.retryable ? ` after ${attempt + 1} attempts` : ''
                    }: ` + `${result.status} ${result.error}: ${result.message}`,
                );
                return;
            }
            const delay = GO_LIVE_RETRY_DELAYS_MS[attempt];
            this.logger.warn(
                `Go-live announcement: ${result.status} ${result.error}, retrying in ${
                    delay / 1000
                }s`,
            );
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    private async post(request: DiscordAnnounceRequest): Promise<DiscordAnnounceResult> {
        try {
            return await postDiscordAnnouncement(request, {
                baseUrl: this.env.get('DISCORD_BOT_URL') ?? '',
                token: this.env.get('DISCORD_INTERNAL_API_TOKEN') ?? '',
                fetch: this.fetch,
            });
        } catch (error) {
            return {
                ok: false,
                status: 0,
                error: 'unreachable',
                message: describe(error),
                retryable: true,
            };
        }
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
        idempotency_key: `twitch:stream-live:${stream.broadcasterId}:${stream.streamId}`,
    };
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
