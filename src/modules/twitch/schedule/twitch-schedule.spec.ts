import {
    scheduledEvent,
    upcomingSegments,
    type TwitchSchedule,
    type TwitchSegment,
    type UpcomingSegment,
} from './twitch-schedule';

const NOW = new Date('2026-11-05T12:00:00Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

function segment(id: string, startOffset: number, overrides: Partial<TwitchSegment> = {}) {
    return {
        id,
        title: `Segment ${id}`,
        start: at(startOffset),
        end: at(startOffset + 3 * HOUR),
        canceledUntil: null,
        category: { id: '518203', name: 'Phasmophobia' },
        ...overrides,
    } satisfies TwitchSegment;
}

function schedule(segments: TwitchSegment[], overrides: Partial<TwitchSchedule> = {}) {
    return {
        broadcasterId: '1000',
        login: 'trama',
        displayName: 'Trama',
        vacation: null,
        segments,
        ...overrides,
    } satisfies TwitchSchedule;
}

const ids = (segments: { id: string }[]) => segments.map(s => s.id);

describe('upcomingSegments', () => {
    it('keeps the segments starting within the next 7 days whose end is still ahead, earliest first', () => {
        const segments = [
            segment('next-week', 7 * DAY),
            segment('tomorrow', DAY),
            segment('ended', -4 * HOUR),
            segment('under-way', -HOUR),
            segment('almost-a-week', 7 * DAY - 1),
        ];
        expect(ids(upcomingSegments(schedule(segments), NOW))).toEqual([
            'under-way',
            'tomorrow',
            'almost-a-week',
        ]);
    });

    it('drops a cancelled segment', () => {
        const segments = [
            segment('on', DAY),
            segment('cancelled', 2 * DAY, { canceledUntil: at(2 * DAY + 3 * HOUR) }),
        ];
        expect(ids(upcomingSegments(schedule(segments), NOW))).toEqual(['on']);
    });

    it('drops the segments that start inside the vacation', () => {
        const segments = [
            segment('before', DAY),
            segment('first-day', 2 * DAY),
            segment('during', 3 * DAY),
            segment('back', 5 * DAY),
        ];
        const vacation = { start: at(2 * DAY), end: at(5 * DAY) };
        expect(ids(upcomingSegments(schedule(segments, { vacation }), NOW))).toEqual([
            'before',
            'back',
        ]);
    });

    it('gives a segment with no end four hours, and judges it by that end', () => {
        const [kept, ...rest] = upcomingSegments(
            schedule([
                segment('open', -3 * HOUR, { end: null }),
                segment('open-ended', -5 * HOUR, { end: null }),
            ]),
            NOW,
        );
        expect(rest).toEqual([]);
        expect(kept.id).toBe('open');
        expect(kept.end).toEqual(at(HOUR));
    });

    it('lists at most 25, the earliest, and each id once', () => {
        const many = Array.from({ length: 30 }, (_, i) => segment(`s${i}`, (30 - i) * HOUR));
        const kept = upcomingSegments(schedule([...many, segment('s29', HOUR)]), NOW);
        expect(kept).toHaveLength(25);
        expect(kept[0].id).toBe('s29');
        expect(new Set(ids(kept)).size).toBe(25);
        expect(kept.at(-1)?.id).toBe('s5');
    });
});

describe('scheduledEvent', () => {
    const upcoming = (overrides: Partial<TwitchSegment> = {}): UpcomingSegment => {
        const [kept] = upcomingSegments(schedule([segment('abc', DAY, overrides)]), NOW);
        return kept;
    };
    const IMAGE = 'https://static-cdn.jtvnw.net/ttv-boxart/518203-600x800.jpg';

    it('is an event at the channel, named after the segment, keyed by its id', () => {
        expect(
            scheduledEvent(upcoming({ title: '  Horror night  ' }), schedule([]), IMAGE),
        ).toEqual({
            key: 'twitch:segment:abc',
            name: 'Horror night',
            description: 'Playing Phasmophobia on Twitch.\nhttps://twitch.tv/trama',
            location: 'https://twitch.tv/trama',
            start: '2026-11-06T12:00:00.000Z',
            end: '2026-11-06T15:00:00.000Z',
            image: IMAGE,
        });
    });

    it('falls back to the category, then the channel, for the name', () => {
        expect(scheduledEvent(upcoming({ title: ' ' }), schedule([])).name).toBe('Phasmophobia');
        const bare = scheduledEvent(upcoming({ title: '', category: null }), schedule([]));
        expect(bare.name).toBe('Trama on Twitch');
        expect(bare.description).toBe('Streaming on Twitch.\nhttps://twitch.tv/trama');
        expect(bare).not.toHaveProperty('image');
    });

    it('ends four hours after the start when Twitch gives no end', () => {
        expect(scheduledEvent(upcoming({ end: null }), schedule([]))).toMatchObject({
            start: '2026-11-06T12:00:00.000Z',
            end: '2026-11-06T16:00:00.000Z',
        });
    });

    it('keeps the name to 100 characters and the description to 900', () => {
        const event = scheduledEvent(
            upcoming({ title: 'x'.repeat(150), category: { id: '1', name: 'y'.repeat(1000) } }),
            schedule([]),
        );
        expect(event.name).toHaveLength(100);
        expect(event.name.endsWith('…')).toBe(true);
        expect(event.description).toHaveLength(900);
        expect(event.description?.endsWith('…')).toBe(true);
    });
});
