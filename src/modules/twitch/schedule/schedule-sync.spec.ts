import { Logger } from '@nestjs/common';
import { testEnvService } from '../../../../test/helpers';
import type { AnnounceFetch } from '../go-live/discord-announce';
import { GO_LIVE_RETRY_DELAYS_MS } from '../go-live/go-live.service';
import type { ScheduleHelix } from './schedule-helix';
import { SCHEDULE_SYNC_INTERVAL_MS, ScheduleSyncService } from './schedule-sync.service';
import type { TwitchSchedule } from './twitch-schedule';

const ENV = {
    TWITCH_BOT_ENABLED: 'true',
    DISCORD_BOT_URL: 'http://discord-bot.test/',
    DISCORD_INTERNAL_API_TOKEN: 't'.repeat(40),
};

const NOW = new Date('2026-11-05T12:00:00Z');
const HOUR = 60 * 60_000;

const SCHEDULE: TwitchSchedule = {
    broadcasterId: '1000',
    login: 'trama',
    displayName: 'Trama',
    vacation: null,
    segments: [
        {
            id: 'seg-1',
            title: 'Horror night',
            start: new Date(NOW.getTime() + 6 * HOUR),
            end: null,
            canceledUntil: null,
            category: { id: '518203', name: 'Phasmophobia' },
        },
        {
            id: 'seg-2',
            title: '',
            start: new Date(NOW.getTime() + 30 * HOUR),
            end: new Date(NOW.getTime() + 32 * HOUR),
            canceledUntil: null,
            category: null,
        },
    ],
};

const BOX_ART = 'https://static-cdn.jtvnw.net/ttv-boxart/518203-600x800.jpg';

const SYNCED = {
    events: [
        { key: 'twitch:segment:seg-1', event_id: '1', event_url: 'u1', outcome: 'created' },
        { key: 'twitch:segment:seg-2', event_id: '2', event_url: 'u2', outcome: 'unchanged' },
    ],
    deleted: [],
};

interface Call {
    url: string;
    headers: Record<string, string>;
    body: { server: string; project: string; source: string; events: Record<string, unknown>[] };
}

type Answer = { status: number; body?: unknown } | Error;

/**
 * A Twitch whose schedule is `read()`'s answer, and a discord-bot that
 * answers each call with the next of `answers`.
 */
function setup(options: {
    answers?: Answer[];
    read?: () => Promise<TwitchSchedule | null>;
    boxArt?: (ids: string[]) => Promise<Map<string, string>>;
    env?: Record<string, string>;
}) {
    const calls: Call[] = [];
    const reads: { from: Date; until: Date }[] = [];
    const boxArtAsked: string[][] = [];
    const helix: ScheduleHelix = {
        getSchedule: async (broadcasterId, from, until) => {
            expect(broadcasterId).toBe('1000');
            reads.push({ from, until });
            return (options.read ?? (async () => SCHEDULE))();
        },
        getBoxArt: async ids => {
            boxArtAsked.push(ids);
            return (options.boxArt ?? (async () => new Map([['518203', BOX_ART]])))(ids);
        },
    };
    const service = new ScheduleSyncService(testEnvService(options.env ?? ENV), helix);
    const answers = options.answers ?? [{ status: 200, body: SYNCED }];
    const fetch: AnnounceFetch = async (url, init) => {
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Call['body'] });
        const answer = answers[calls.length - 1];
        if (!answer) throw new Error(`unexpected call ${calls.length}`);
        if (answer instanceof Error) throw answer;
        return {
            status: answer.status,
            json: async () => {
                if (answer.body === undefined) throw new SyntaxError('not JSON');
                return answer.body;
            },
        };
    };
    service.fetch = fetch;
    return { service, calls, reads, boxArtAsked };
}

describe('ScheduleSyncService', () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('is off, and reads and sends nothing, without DISCORD_BOT_URL or with the bot switched off', async () => {
        for (const env of [
            { TWITCH_BOT_ENABLED: 'true' },
            { ...ENV, TWITCH_BOT_ENABLED: 'false' },
        ]) {
            const { service, calls, reads } = setup({ env, answers: [] });
            expect(service.enabled).toBe(false);
            service.onApplicationBootstrap();
            await service.sync();
            expect(reads).toEqual([]);
            expect(calls).toEqual([]);
        }
    });

    it('sends the coming week’s segments to the bot’s events endpoint as one sync, with its bearer token', async () => {
        const { service, calls, reads, boxArtAsked } = setup({});
        await service.sync();

        expect(reads).toEqual([
            {
                from: new Date('2026-11-04T12:00:00Z'),
                until: new Date('2026-11-12T12:00:00Z'),
            },
        ]);
        expect(boxArtAsked).toEqual([['518203']]);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('http://discord-bot.test/api/internal/announce/events');
        expect(calls[0].headers).toEqual({
            Authorization: `Bearer ${'t'.repeat(40)}`,
            'Content-Type': 'application/json',
        });
        expect(calls[0].body).toEqual({
            server: 'home',
            project: 'brobot',
            source: 'twitch:1000',
            events: [
                {
                    key: 'twitch:segment:seg-1',
                    name: 'Horror night',
                    description: 'Playing Phasmophobia on Twitch.\nhttps://twitch.tv/trama',
                    location: 'https://twitch.tv/trama',
                    start: '2026-11-05T18:00:00.000Z',
                    end: '2026-11-05T22:00:00.000Z',
                    image: BOX_ART,
                },
                {
                    key: 'twitch:segment:seg-2',
                    name: 'Trama on Twitch',
                    description: 'Streaming on Twitch.\nhttps://twitch.tv/trama',
                    location: 'https://twitch.tv/trama',
                    start: '2026-11-06T18:00:00.000Z',
                    end: '2026-11-06T20:00:00.000Z',
                },
            ],
        });
    });

    it('sends to the configured server', async () => {
        const { service, calls } = setup({ env: { ...ENV, DISCORD_ANNOUNCE_SERVER: 'friends' } });
        await service.sync();
        expect(calls[0].body.server).toBe('friends');
    });

    it('sends an empty list when the broadcaster has no schedule (Helix 404), which deletes the events', async () => {
        const { service, calls, boxArtAsked } = setup({
            read: async () => null,
            answers: [{ status: 200, body: { events: [], deleted: [] } }],
        });
        await service.sync();
        expect(boxArtAsked).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(calls[0].body).toEqual({
            server: 'home',
            project: 'brobot',
            source: 'twitch:1000',
            events: [],
        });
    });

    it('sends nothing when Helix fails otherwise: an empty list would delete every event', async () => {
        const failing = [
            setup({
                answers: [],
                read: async () => {
                    throw Object.assign(new Error('Helix 500'), { statusCode: 500 });
                },
            }),
            setup({
                answers: [],
                boxArt: async () => {
                    throw new Error('Helix timeout');
                },
            }),
        ];
        for (const { service, calls } of failing) {
            await service.sync();
            expect(calls).toEqual([]);
        }
    });

    it('runs overlapping triggers as one sync in flight and at most one queued', async () => {
        let release: () => void = () => undefined;
        let reads = 0;
        const { service, calls } = setup({
            answers: [
                { status: 200, body: SYNCED },
                { status: 200, body: SYNCED },
            ],
            read: async () => {
                reads++;
                if (reads === 1) await new Promise<void>(resolve => (release = resolve));
                return SCHEDULE;
            },
        });
        const first = service.sync();
        const second = service.sync();
        const third = service.sync();
        const fourth = service.sync();
        expect(third).toBe(second);
        expect(fourth).toBe(second);
        await Promise.resolve();
        expect(reads).toBe(1);

        release();
        await Promise.all([first, second, third, fourth]);
        expect(reads).toBe(2);
        expect(calls).toHaveLength(2);

        // Once idle, the next trigger runs straight away.
        const { service: idle, calls: idleCalls } = setup({});
        await idle.sync();
        expect(idleCalls).toHaveLength(1);
    });

    it('retries a 502, a 503 or an unreachable bot with go-live’s backoff, then stops on success', async () => {
        vi.useFakeTimers({ now: NOW });
        const { service, calls } = setup({
            answers: [
                { status: 503, body: { error: 'gateway_unavailable', message: 'reconnecting' } },
                new TypeError('fetch failed'),
                { status: 502 },
                { status: 200, body: SYNCED },
            ],
        });
        const done = service.sync();
        for (const delay of GO_LIVE_RETRY_DELAYS_MS.slice(0, 3))
            await vi.advanceTimersByTimeAsync(delay);
        await done;
        expect(calls).toHaveLength(4);
        expect(new Set(calls.map(call => JSON.stringify(call.body))).size).toBe(1);
    });

    it('gives up after the last retry', async () => {
        vi.useFakeTimers({ now: NOW });
        const { service, calls } = setup({
            answers: Array.from({ length: GO_LIVE_RETRY_DELAYS_MS.length + 1 }, () => ({
                status: 503,
            })),
        });
        const done = service.sync();
        for (const delay of GO_LIVE_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
        await done;
        expect(calls).toHaveLength(GO_LIVE_RETRY_DELAYS_MS.length + 1);
    });

    it('logs a 4xx without retrying, saying what it means', async () => {
        const errors: string[] = [];
        vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
            errors.push(String(message));
        });
        const refusals: [Answer, RegExp][] = [
            [
                { status: 422, body: { error: 'no_route', message: 'brobot has no events' } },
                /422 no_route: .*scheduled events are not on for brobot in the bot's server file/,
            ],
            [
                {
                    status: 404,
                    body: { statusCode: 404, message: 'Cannot POST', error: 'Not Found' },
                },
                /404 .*has not deployed \/api\/internal\/announce\/events yet/,
            ],
            [{ status: 404 }, /404 http_error: HTTP 404 .*has not deployed/],
            [
                { status: 404, body: { error: 'unknown_server', message: 'no server home' } },
                /404 unknown_server: no server home$/,
            ],
            [
                { status: 400, body: { error: 'invalid_request', message: 'bad' } },
                /400 invalid_request: bad$/,
            ],
        ];
        for (const [answer, logged] of refusals) {
            errors.length = 0;
            const { service, calls } = setup({ answers: [answer] });
            await service.sync();
            expect(calls).toHaveLength(1);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toMatch(logged);
        }
    });

    it('syncs at startup and every 15 minutes until shutdown', async () => {
        vi.useFakeTimers({ now: NOW });
        const { service, calls } = setup({
            answers: [
                { status: 200, body: SYNCED },
                { status: 200, body: SYNCED },
            ],
        });
        service.onApplicationBootstrap();
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(SCHEDULE_SYNC_INTERVAL_MS);
        expect(calls).toHaveLength(2);

        service.onApplicationShutdown();
        await vi.advanceTimersByTimeAsync(SCHEDULE_SYNC_INTERVAL_MS * 2);
        expect(calls).toHaveLength(2);
    });
});
