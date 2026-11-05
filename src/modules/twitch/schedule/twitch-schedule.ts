import { type DiscordScheduledEvent, DISCORD_EVENTS_LIMITS } from '../go-live/discord-announce';

/** A broadcaster's Twitch schedule, as Helix `GET /schedule` gives it. */
export interface TwitchSchedule {
    broadcasterId: string;
    login: string;
    displayName: string;
    /** Set while the streamer is on vacation: no segment inside it is streamed. */
    vacation: { start: Date; end: Date } | null;
    segments: TwitchSegment[];
}

export interface TwitchSegment {
    /** Unique per occurrence of a recurring segment. */
    id: string;
    /** May be blank. */
    title: string;
    start: Date;
    /** `null` when Twitch gives none. */
    end: Date | null;
    /** Set when the streamer cancelled this occurrence. */
    canceledUntil: Date | null;
    category: { id: string; name: string } | null;
}

/** A segment that is synced, with its end settled. */
export interface UpcomingSegment extends TwitchSegment {
    end: Date;
}

/** How far ahead segments are synced. */
export const SCHEDULE_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** A segment's length when Twitch gives no end: Discord's external events need one. */
export const SEGMENT_FALLBACK_MS = 4 * 60 * 60_000;

/**
 * The segments to sync at `now`: starting within {@link SCHEDULE_WINDOW_MS}
 * and not yet over, neither cancelled nor inside the vacation, earliest
 * first, at most as many as one sync carries.
 */
export function upcomingSegments(schedule: TwitchSchedule, now: Date): UpcomingSegment[] {
    const until = now.getTime() + SCHEDULE_WINDOW_MS;
    const { vacation } = schedule;
    const seen = new Set<string>();
    return schedule.segments
        .map(segment => ({
            ...segment,
            end: segment.end ?? new Date(segment.start.getTime() + SEGMENT_FALLBACK_MS),
        }))
        .filter(segment => {
            const start = segment.start.getTime();
            if (start >= until || segment.end.getTime() <= now.getTime()) return false;
            if (segment.canceledUntil) return false;
            if (vacation && start >= vacation.start.getTime() && start < vacation.end.getTime())
                return false;
            // The bot refuses a sync with a key listed twice.
            if (seen.has(segment.id)) return false;
            seen.add(segment.id);
            return true;
        })
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .slice(0, DISCORD_EVENTS_LIMITS.count);
}

/**
 * The Discord Scheduled Event for one segment: named after its title, else
 * its category, at the channel, with the category's box art (`image`, the
 * URL with Twitch's size template filled) as the cover.
 */
export function scheduledEvent(
    segment: UpcomingSegment,
    schedule: Pick<TwitchSchedule, 'login' | 'displayName'>,
    image?: string,
): DiscordScheduledEvent {
    const url = `https://twitch.tv/${schedule.login}`;
    const title = segment.title.trim();
    const category = segment.category?.name.trim();
    return {
        key: `twitch:segment:${segment.id}`,
        // A blank title or category falls through to the next.
        name: clip(
            [title, category].find(Boolean) ?? `${schedule.displayName} on Twitch`,
            DISCORD_EVENTS_LIMITS.name,
        ),
        description: clip(
            `${category ? `Playing ${category} on Twitch.` : 'Streaming on Twitch.'}\n${url}`,
            DISCORD_EVENTS_LIMITS.description,
        ),
        location: clip(url, DISCORD_EVENTS_LIMITS.location),
        start: segment.start.toISOString(),
        end: segment.end.toISOString(),
        ...(image ? { image } : {}),
    };
}

function clip(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
