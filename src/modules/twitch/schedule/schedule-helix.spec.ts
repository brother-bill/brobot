import { testEnvService } from '../../../../test/helpers';
import { TwurpleScheduleHelix } from './schedule-helix';

interface FakeSegment {
    id: string;
    title: string;
    startDate: Date;
    endDate: Date;
    cancelEndDate: Date | null;
    categoryId: string | null;
    categoryName: string | null;
}

const twurple = vi.hoisted(() => ({
    pages: [] as ({ segments: FakeSegment[]; cursor?: string } | Error)[],
    queries: [] as { broadcaster: string; filter: Record<string, unknown> }[],
    gameIds: [] as string[][],
}));

vi.mock('@twurple/auth', () => ({ AppTokenAuthProvider: class {} }));
vi.mock('@twurple/api', () => ({
    ApiClient: class {
        schedule = {
            getSchedule: async (broadcaster: string, filter: Record<string, unknown>) => {
                twurple.queries.push({ broadcaster, filter });
                const page = twurple.pages.shift();
                if (!page) throw new Error('no more pages');
                if (page instanceof Error) throw page;
                return {
                    data: {
                        broadcasterId: '1000',
                        broadcasterName: 'trama',
                        broadcasterDisplayName: 'Trama',
                        vacationStartDate: new Date('2026-12-20T00:00:00Z'),
                        vacationEndDate: new Date('2027-01-02T00:00:00Z'),
                        segments: page.segments,
                    },
                    cursor: page.cursor,
                };
            },
        };

        games = {
            getGamesByIds: async (ids: string[]) => {
                twurple.gameIds.push(ids);
                return ids.map(id => ({
                    id,
                    getBoxArtUrl: (width: number, height: number) =>
                        `https://static-cdn.jtvnw.net/ttv-boxart/${id}-{width}x{height}.jpg`
                            .replace('{width}', String(width))
                            .replace('{height}', String(height)),
                }));
            },
        };
    },
}));

const FROM = new Date('2026-11-04T12:00:00Z');
const UNTIL = new Date('2026-11-12T12:00:00Z');

function segment(id: string, start: string, overrides: Partial<FakeSegment> = {}): FakeSegment {
    const startDate = new Date(start);
    return {
        id,
        title: `Segment ${id}`,
        startDate,
        endDate: new Date(startDate.getTime() + 2 * 60 * 60_000),
        cancelEndDate: null,
        categoryId: '518203',
        categoryName: 'Phasmophobia',
        ...overrides,
    };
}

describe('TwurpleScheduleHelix', () => {
    beforeEach(() => {
        twurple.pages = [];
        twurple.queries = [];
        twurple.gameIds = [];
    });

    const helix = () => new TwurpleScheduleHelix(testEnvService());

    it('reads the schedule from `from`, page by page until a segment starts past `until`', async () => {
        twurple.pages = [
            { segments: [segment('a', '2026-11-05T18:00:00Z')], cursor: 'c1' },
            {
                segments: [
                    segment('b', '2026-11-08T18:00:00Z', {
                        endDate: new Date(0),
                        categoryId: null,
                        categoryName: null,
                    }),
                    segment('c', '2026-11-13T18:00:00Z', {
                        cancelEndDate: new Date('2026-11-13T20:00:00Z'),
                    }),
                ],
                cursor: 'c2',
            },
        ];
        const schedule = await helix().getSchedule('1000', FROM, UNTIL);

        expect(twurple.queries).toEqual([
            {
                broadcaster: '1000',
                filter: { startDate: FROM.toISOString(), limit: 25, after: undefined },
            },
            {
                broadcaster: '1000',
                filter: { startDate: FROM.toISOString(), limit: 25, after: 'c1' },
            },
        ]);
        expect(schedule).toEqual({
            broadcasterId: '1000',
            login: 'trama',
            displayName: 'Trama',
            vacation: {
                start: new Date('2026-12-20T00:00:00Z'),
                end: new Date('2027-01-02T00:00:00Z'),
            },
            segments: [
                {
                    id: 'a',
                    title: 'Segment a',
                    start: new Date('2026-11-05T18:00:00Z'),
                    end: new Date('2026-11-05T20:00:00Z'),
                    canceledUntil: null,
                    category: { id: '518203', name: 'Phasmophobia' },
                },
                // Twurple reads a missing end_time as the epoch: no end.
                {
                    id: 'b',
                    title: 'Segment b',
                    start: new Date('2026-11-08T18:00:00Z'),
                    end: null,
                    canceledUntil: null,
                    category: null,
                },
                {
                    id: 'c',
                    title: 'Segment c',
                    start: new Date('2026-11-13T18:00:00Z'),
                    end: new Date('2026-11-13T20:00:00Z'),
                    canceledUntil: new Date('2026-11-13T20:00:00Z'),
                    category: { id: '518203', name: 'Phasmophobia' },
                },
            ],
        });
    });

    it('answers null for a broadcaster with no schedule (Helix 404)', async () => {
        twurple.pages = [Object.assign(new Error('Not Found'), { statusCode: 404 })];
        await expect(helix().getSchedule('1000', FROM, UNTIL)).resolves.toBeNull();
    });

    it('throws any other Helix failure', async () => {
        twurple.pages = [Object.assign(new Error('Internal Server Error'), { statusCode: 500 })];
        await expect(helix().getSchedule('1000', FROM, UNTIL)).rejects.toThrow(
            'Internal Server Error',
        );

        twurple.pages = [
            { segments: [segment('a', '2026-11-05T18:00:00Z')], cursor: 'c1' },
            Object.assign(new Error('Service Unavailable'), { statusCode: 503 }),
        ];
        await expect(helix().getSchedule('1000', FROM, UNTIL)).rejects.toThrow(
            'Service Unavailable',
        );
    });

    it('fills the box art’s size template, and asks for nothing without categories', async () => {
        const boxArt = await helix().getBoxArt(['518203', '509658']);
        expect(boxArt).toEqual(
            new Map([
                ['518203', 'https://static-cdn.jtvnw.net/ttv-boxart/518203-600x800.jpg'],
                ['509658', 'https://static-cdn.jtvnw.net/ttv-boxart/509658-600x800.jpg'],
            ]),
        );
        await expect(helix().getBoxArt([])).resolves.toEqual(new Map());
        expect(twurple.gameIds).toEqual([['518203', '509658']]);
    });
});
