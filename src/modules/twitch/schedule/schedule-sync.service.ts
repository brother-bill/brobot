import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { EnvService } from '../../../config/env.service';
import {
    type AnnounceFetch,
    type DiscordAnnounceFailure,
    type DiscordScheduledEvent,
    type DiscordScheduledEventsRequest,
    sendWithRetries,
    syncDiscordScheduledEvents,
} from '../go-live/discord-announce';
import { GO_LIVE_RETRY_DELAYS_MS } from '../go-live/go-live.service';
import { SCHEDULE_HELIX, type ScheduleHelix } from './schedule-helix';
import { SCHEDULE_WINDOW_MS, scheduledEvent, upcomingSegments } from './twitch-schedule';

/** How often the schedule is synced without a trigger. */
export const SCHEDULE_SYNC_INTERVAL_MS = 15 * 60_000;

/** How far back the Helix read starts, so a segment already under way is still listed. */
const SEGMENT_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * Mirrors the streamer's Twitch schedule into Discord Scheduled Events,
 * through the discord-bot's `POST /api/internal/announce/events`: each
 * segment of the coming week becomes an event at the channel, and the bot
 * creates, updates and deletes its events of this source to match the list.
 *
 * Syncs at startup, every {@link SCHEDULE_SYNC_INTERVAL_MS} and on EventSub's
 * `channel.update` (subscribed by `EventSubService`). Triggers that
 * overlap coalesce: one sync in flight and at most one queued behind it.
 *
 * A broadcaster with no schedule (Helix 404) is an empty list, which deletes
 * the events; any other failed read sends nothing, since an empty list would
 * delete every event. A 5xx or an unreachable bot is retried as the go-live
 * announcement is; a 4xx is logged.
 *
 * Off unless the go-live announcement's `DISCORD_BOT_URL` (and so
 * `DISCORD_INTERNAL_API_TOKEN`) is set, and with `TWITCH_BOT_ENABLED=false`,
 * under which nothing in the bot reaches Twitch.
 */
@Injectable()
export class ScheduleSyncService implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(ScheduleSyncService.name);
    private timer: ReturnType<typeof setInterval> | null = null;
    private running: Promise<void> | null = null;
    private queued: Promise<void> | null = null;
    /** Tests replace it; production uses the global `fetch`. */
    fetch: AnnounceFetch | undefined;

    constructor(
        private readonly env: EnvService,
        @Inject(SCHEDULE_HELIX) private readonly helix: ScheduleHelix,
    ) {}

    get enabled(): boolean {
        return Boolean(
            this.env.get('TWITCH_BOT_ENABLED') &&
                this.env.get('DISCORD_BOT_URL') &&
                this.env.get('DISCORD_INTERNAL_API_TOKEN'),
        );
    }

    onApplicationBootstrap(): void {
        if (!this.enabled) {
            this.logger.log(
                this.env.get('TWITCH_BOT_ENABLED')
                    ? 'Discord schedule sync is off (DISCORD_BOT_URL unset)'
                    : 'Discord schedule sync is off (TWITCH_BOT_ENABLED=false)',
            );
            return;
        }
        void this.sync();
        this.timer = setInterval(() => void this.sync(), SCHEDULE_SYNC_INTERVAL_MS);
        this.timer.unref();
    }

    onApplicationShutdown(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /**
     * Syncs now, or after the sync in flight; a trigger arriving while one is
     * already queued joins it. Never throws.
     */
    sync(): Promise<void> {
        if (!this.enabled) return Promise.resolve();
        if (!this.running) {
            this.running = this.run()
                .catch((error: unknown) => {
                    this.logger.error(`Twitch schedule sync failed: ${describe(error)}`);
                })
                .finally(() => {
                    this.running = null;
                });
            return this.running;
        }
        this.queued ??= this.running.then(() => {
            this.queued = null;
            return this.sync();
        });
        return this.queued;
    }

    private async run(): Promise<void> {
        const events = await this.read().catch((error: unknown) => {
            this.logger.warn(`Twitch schedule read failed, nothing synced: ${describe(error)}`);
            return null;
        });
        if (!events) return;
        const request: DiscordScheduledEventsRequest = {
            server: this.env.get('DISCORD_ANNOUNCE_SERVER'),
            project: 'brobot',
            source: `twitch:${this.env.get('TWITCH_STREAMER_OAUTH_ID')}`,
            events,
        };
        const result = await sendWithRetries(
            'Twitch schedule sync',
            () =>
                syncDiscordScheduledEvents(request, {
                    baseUrl: this.env.get('DISCORD_BOT_URL') ?? '',
                    token: this.env.get('DISCORD_INTERNAL_API_TOKEN') ?? '',
                    fetch: this.fetch,
                }),
            { delays: GO_LIVE_RETRY_DELAYS_MS, logger: this.logger, hint: refusalHint },
        );
        if (!result.ok) return;
        const count = (outcome: string) =>
            result.response.events.filter(event => event.outcome === outcome).length;
        const created = count('created');
        const updated = count('updated');
        const deleted = result.response.deleted.length;
        const summary =
            `Twitch schedule synced to Discord: ${events.length} events ` +
            `(${created} created, ${updated} updated), ${deleted} deleted`;
        if (created || updated || deleted) this.logger.log(summary);
        else this.logger.debug(summary);
    }

    /** The events to list, or a throw when Twitch could not say. */
    private async read(): Promise<DiscordScheduledEvent[]> {
        const now = new Date();
        const schedule = await this.helix.getSchedule(
            this.env.get('TWITCH_STREAMER_OAUTH_ID'),
            new Date(now.getTime() - SEGMENT_LOOKBACK_MS),
            new Date(now.getTime() + SCHEDULE_WINDOW_MS),
        );
        if (!schedule) return [];
        const segments = upcomingSegments(schedule, now);
        const categories = [...new Set(segments.flatMap(segment => segment.category?.id ?? []))];
        const boxArt = await this.helix.getBoxArt(categories);
        return segments.map(segment =>
            scheduledEvent(
                segment,
                schedule,
                segment.category ? boxArt.get(segment.category.id) : undefined,
            ),
        );
    }
}

/** What a refusal says about the bot's setup, where it says something. */
function refusalHint(failure: DiscordAnnounceFailure): string | undefined {
    if (failure.error === 'no_route')
        return "scheduled events are not on for brobot in the bot's server file";
    if (
        failure.status === 404 &&
        failure.error !== 'unknown_server' &&
        failure.error !== 'unknown_project'
    )
        return 'the discord-bot has not deployed /api/internal/announce/events yet';
    return undefined;
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
