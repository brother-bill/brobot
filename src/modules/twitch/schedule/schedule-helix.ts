import { Injectable } from '@nestjs/common';
import { ApiClient, type HelixScheduleSegment } from '@twurple/api';
import { AppTokenAuthProvider } from '@twurple/auth';
import { EnvService } from '../../../config/env.service';
import type { TwitchSchedule, TwitchSegment } from './twitch-schedule';

/** The Helix reads behind the schedule sync ({@link TwurpleScheduleHelix} in production). */
export interface ScheduleHelix {
    /**
     * The broadcaster's segments starting from `from`, read until one starts
     * at `until` or later; `null` when the broadcaster has no schedule (Helix
     * 404). Any other failure throws.
     */
    getSchedule(broadcasterId: string, from: Date, until: Date): Promise<TwitchSchedule | null>;
    /** Box-art URLs by category id, with the size filled in. Throws on failure. */
    getBoxArt(categoryIds: string[]): Promise<Map<string, string>>;
}

export const SCHEDULE_HELIX = Symbol('SCHEDULE_HELIX');

/** Helix's page size for `GET /schedule`, and its maximum. */
const PAGE_SIZE = 25;
/** Enough pages for a week of a busy schedule; a runaway cursor stops here. */
const MAX_PAGES = 4;
/** Twitch's box art is 3:4. */
const BOX_ART = { width: 600, height: 800 } as const;

/**
 * Reads the schedule with the app token (`GET /schedule` needs no user
 * grant), on an ApiClient of its own: EventSub's exists only while EventSub
 * is on.
 */
@Injectable()
export class TwurpleScheduleHelix implements ScheduleHelix {
    private api: ApiClient | null = null;

    constructor(private readonly env: EnvService) {}

    async getSchedule(
        broadcasterId: string,
        from: Date,
        until: Date,
    ): Promise<TwitchSchedule | null> {
        const api = this.client();
        let schedule: TwitchSchedule | null = null;
        let after: string | undefined;
        try {
            for (let page = 0; page < MAX_PAGES; page++) {
                const result = await api.schedule.getSchedule(broadcasterId, {
                    startDate: from.toISOString(),
                    limit: PAGE_SIZE,
                    after,
                });
                const { data } = result;
                const vacationStart = data.vacationStartDate;
                const vacationEnd = data.vacationEndDate;
                schedule ??= {
                    broadcasterId: data.broadcasterId,
                    login: data.broadcasterName,
                    displayName: data.broadcasterDisplayName,
                    vacation:
                        vacationStart && vacationEnd
                            ? { start: vacationStart, end: vacationEnd }
                            : null,
                    segments: [],
                };
                const segments = data.segments.map(toSegment);
                schedule.segments.push(...segments);
                after = result.cursor;
                const last = segments.at(-1);
                if (!after || !last || last.start.getTime() >= until.getTime()) break;
            }
        } catch (error) {
            // Helix answers 404 for a broadcaster who has never set a schedule, or has emptied it.
            if ((error as { statusCode?: unknown } | null)?.statusCode === 404) return null;
            throw error;
        }
        return schedule;
    }

    async getBoxArt(categoryIds: string[]): Promise<Map<string, string>> {
        if (categoryIds.length === 0) return new Map();
        const games = await this.client().games.getGamesByIds(categoryIds);
        return new Map(
            games.map(game => [game.id, game.getBoxArtUrl(BOX_ART.width, BOX_ART.height)]),
        );
    }

    private client(): ApiClient {
        this.api ??= new ApiClient({
            authProvider: new AppTokenAuthProvider(
                this.env.get('TWITCH_CLIENT_ID'),
                this.env.get('TWITCH_CLIENT_SECRET'),
            ),
        });
        return this.api;
    }
}

function toSegment(segment: HelixScheduleSegment): TwitchSegment {
    const start = segment.startDate;
    // Twurple reads a missing `end_time` as the epoch.
    const end = segment.endDate;
    const { categoryId, categoryName } = segment;
    return {
        id: segment.id,
        title: segment.title,
        start,
        end: end.getTime() > start.getTime() ? end : null,
        canceledUntil: segment.cancelEndDate,
        category: categoryId && categoryName ? { id: categoryId, name: categoryName } : null,
    };
}
