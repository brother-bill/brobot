import { testEnvService } from '../../../../test/helpers';
import type { AnnounceFetch } from './discord-announce';
import {
    GO_LIVE_RETRY_DELAYS_MS,
    GoLiveService,
    goLiveAnnouncement,
    wasLiveEdit,
    type StreamOnline,
} from './go-live.service';

const DISCORD = {
    DISCORD_BOT_URL: 'http://discord-bot.test/',
    DISCORD_INTERNAL_API_TOKEN: 't'.repeat(40),
};

const STREAM: StreamOnline = {
    streamId: '4242',
    type: 'live',
    broadcasterId: '1000',
    login: 'trama',
    displayName: 'Trama',
    startedAt: new Date('2026-11-04T18:00:00Z'),
};
const CHANNEL = { title: 'Horror night', gameName: 'Phasmophobia' };

const POSTED = {
    duplicate: false,
    message_id: '9',
    message_url: 'https://discord.com/channels/1/2/9',
    channel_id: '2',
    crossposted: true,
};

interface Call {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
}

/** A discord-bot that answers each call with the next of `answers` (a status and a body, or a thrown error). */
function setup(
    answers: ({ status: number; body?: unknown } | Error)[],
    env: Record<string, string> = DISCORD,
) {
    const calls: Call[] = [];
    const service = new GoLiveService(testEnvService(env));
    const fetch: AnnounceFetch = async (url, init) => {
        calls.push({
            url,
            headers: init.headers,
            body: JSON.parse(init.body) as Record<string, unknown>,
        });
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
    return { service, calls };
}

describe('goLiveAnnouncement', () => {
    it('announces the title, category, preview and link, pinging nobody, once per broadcast', () => {
        expect(goLiveAnnouncement(STREAM, CHANNEL, 'home')).toEqual({
            server: 'home',
            project: 'brobot',
            kind: 'stream-live',
            title: 'Trama is live: Horror night',
            body: 'Playing **Phasmophobia** on Twitch.\n[Watch the stream](https://www.twitch.tv/trama)',
            url: 'https://www.twitch.tv/trama',
            image: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_trama-1280x720.jpg?stream=4242',
            ping: 'none',
            idempotency_key: 'twitch:stream-live:1000:4242',
        });
    });

    it('still announces without the channel info, and keeps the streamer’s text literal and in Discord’s limits', () => {
        const bare = goLiveAnnouncement(STREAM, null, 'home');
        expect(bare.title).toBe('Trama is live on Twitch');
        expect(bare.body).toBe(
            'Live now on Twitch.\n[Watch the stream](https://www.twitch.tv/trama)',
        );

        const long = goLiveAnnouncement(
            STREAM,
            { title: 'x'.repeat(300), gameName: 'Just_Chatting *' },
            'home',
        );
        expect(long.title).toHaveLength(256);
        expect(long.title.endsWith('…')).toBe(true);
        expect(long.body.startsWith('Playing **Just\\_Chatting \\*** on Twitch.')).toBe(true);
    });
});

describe('GoLiveService', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('is off, and posts nothing, without DISCORD_BOT_URL', async () => {
        const { service, calls } = setup([], {});
        expect(service.enabled).toBe(false);
        await service.streamOnline(STREAM, async () => CHANNEL);
        expect(calls).toEqual([]);
    });

    it('posts to the bot’s announce endpoint with its bearer token', async () => {
        const { service, calls } = setup([{ status: 201, body: POSTED }]);
        expect(service.enabled).toBe(true);
        await service.streamOnline(STREAM, async () => CHANNEL);

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('http://discord-bot.test/api/internal/announce');
        expect(calls[0].headers).toEqual({
            Authorization: `Bearer ${'t'.repeat(40)}`,
            'Content-Type': 'application/json',
        });
        expect(calls[0].body).toEqual(goLiveAnnouncement(STREAM, CHANNEL, 'home'));
    });

    it('sends to the configured server', async () => {
        const { service, calls } = setup([{ status: 201, body: POSTED }], {
            ...DISCORD,
            DISCORD_ANNOUNCE_SERVER: 'friends',
        });
        await service.streamOnline(STREAM, async () => CHANNEL);
        expect(calls[0].body.server).toBe('friends');
    });

    it('announces a rerun or premiere not at all', async () => {
        const { service, calls } = setup([]);
        await service.streamOnline({ ...STREAM, type: 'rerun' }, async () => CHANNEL);
        expect(calls).toEqual([]);
    });

    it('announces without the title when Helix fails', async () => {
        const { service, calls } = setup([{ status: 201, body: POSTED }]);
        await service.streamOnline(STREAM, async () => {
            throw new Error('Helix down');
        });
        expect(calls[0].body.title).toBe('Trama is live on Twitch');
    });

    it('retries a 5xx or an unreachable bot with the same key, then stops on success', async () => {
        vi.useFakeTimers();
        const { service, calls } = setup([
            { status: 503, body: { error: 'gateway_unavailable', message: 'reconnecting' } },
            new TypeError('fetch failed'),
            { status: 502 },
            { status: 200, body: { ...POSTED, duplicate: true } },
        ]);
        const done = service.streamOnline(STREAM, async () => CHANNEL);
        for (const delay of GO_LIVE_RETRY_DELAYS_MS.slice(0, 3))
            await vi.advanceTimersByTimeAsync(delay);
        await done;

        expect(calls).toHaveLength(4);
        expect(new Set(calls.map(call => call.body.idempotency_key))).toEqual(
            new Set(['twitch:stream-live:1000:4242']),
        );
    });

    it('gives up after the last retry', async () => {
        vi.useFakeTimers();
        const failures = Array.from({ length: GO_LIVE_RETRY_DELAYS_MS.length + 1 }, () => ({
            status: 503,
        }));
        const { service, calls } = setup(failures);
        const done = service.streamOnline(STREAM, async () => CHANNEL);
        for (const delay of GO_LIVE_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
        await done;
        expect(calls).toHaveLength(GO_LIVE_RETRY_DELAYS_MS.length + 1);
    });

    it('does not retry a refusal: the request or the bot’s configuration is wrong', async () => {
        const { service, calls } = setup([
            {
                status: 422,
                body: { error: 'no_route', message: 'brobot has no stream-live channel' },
            },
        ]);
        await service.streamOnline(STREAM, async () => CHANNEL);
        expect(calls).toHaveLength(1);
    });
});

const EDITED = {
    message_id: '9',
    message_url: 'https://discord.com/channels/1/2/9',
    channel_id: '2',
};

describe('wasLiveEdit', () => {
    it('says what was streamed and for how long, drops the preview and relabels the footer, under the go-live key', () => {
        expect(wasLiveEdit(STREAM, CHANNEL, 'home', new Date('2026-11-04T20:14:20Z'))).toEqual({
            server: 'home',
            idempotency_key: 'twitch:stream-live:1000:4242',
            title: 'Trama was live: Horror night',
            body: 'Streamed **Phasmophobia** for 2 h 14 min.\n[Past broadcasts](https://www.twitch.tv/trama/videos)',
            image: null,
            label: 'Was live',
        });
        expect(goLiveAnnouncement(STREAM, CHANNEL, 'home').idempotency_key).toBe(
            'twitch:stream-live:1000:4242',
        );
    });

    it('says less when it knows less', () => {
        const at = (iso: string) => new Date(iso);
        expect(wasLiveEdit(STREAM, CHANNEL, 'home', at('2026-11-04T21:00:00Z')).body).toMatch(
            /^Streamed \*\*Phasmophobia\*\* for 3 h\./,
        );
        expect(wasLiveEdit(STREAM, null, 'home', at('2026-11-04T18:45:00Z'))).toMatchObject({
            title: 'Trama was live on Twitch',
            body: expect.stringMatching(/^Streamed for 45 min\.\n/) as unknown,
        });
        expect(wasLiveEdit(STREAM, null, 'home', at('2026-11-04T18:00:20Z')).body).toMatch(
            /^The stream has ended\.\n/,
        );
    });
});

describe('GoLiveService: the stream ending', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('edits the go-live post through the bot’s edit endpoint once the stream goes offline', async () => {
        vi.useFakeTimers({ now: new Date('2026-11-04T19:30:00Z'), toFake: ['Date'] });
        const { service, calls } = setup([
            { status: 201, body: POSTED },
            { status: 200, body: EDITED },
        ]);
        await service.streamOnline(STREAM, async () => CHANNEL);
        await service.streamOffline('1000');

        expect(calls).toHaveLength(2);
        expect(calls[1].url).toBe('http://discord-bot.test/api/internal/announce/edit');
        expect(calls[1].headers.Authorization).toBe(`Bearer ${'t'.repeat(40)}`);
        expect(calls[1].body).toEqual(
            wasLiveEdit(STREAM, CHANNEL, 'home', new Date('2026-11-04T19:30:00Z')),
        );
    });

    it('waits for a go-live post still being retried, then edits it', async () => {
        vi.useFakeTimers();
        const { service, calls } = setup([
            { status: 503 },
            { status: 201, body: POSTED },
            { status: 200, body: EDITED },
        ]);
        const online = service.streamOnline(STREAM, async () => CHANNEL);
        const offline = service.streamOffline('1000');
        await vi.advanceTimersByTimeAsync(GO_LIVE_RETRY_DELAYS_MS[0]);
        await Promise.all([online, offline]);
        expect(calls.map(call => call.url.split('/').pop())).toEqual([
            'announce',
            'announce',
            'edit',
        ]);
    });

    it('edits nothing when the go-live post never went out, or there was none', async () => {
        const { service, calls } = setup([
            { status: 422, body: { error: 'no_route', message: 'no stream-live channel' } },
        ]);
        await service.streamOnline(STREAM, async () => CHANNEL);
        await service.streamOffline('1000');
        await service.streamOffline('1000');
        expect(calls).toHaveLength(1);
    });

    it('retries a 5xx edit, and stops at a post the bot has forgotten', async () => {
        vi.useFakeTimers();
        const { service, calls } = setup([
            { status: 201, body: POSTED },
            { status: 502 },
            { status: 404, body: { error: 'unknown_post', message: 'forgotten' } },
        ]);
        await service.streamOnline(STREAM, async () => CHANNEL);
        const offline = service.streamOffline('1000');
        await vi.advanceTimersByTimeAsync(GO_LIVE_RETRY_DELAYS_MS[0]);
        await offline;
        expect(calls).toHaveLength(3);
    });

    it('marks the end of a stream already on air when brobot started, without announcing it again', async () => {
        vi.useFakeTimers({ now: new Date('2026-11-04T19:00:00Z'), toFake: ['Date'] });
        const { service, calls } = setup([{ status: 200, body: EDITED }]);
        service.resume(STREAM, CHANNEL);
        await service.streamOffline('1000');
        expect(calls).toHaveLength(1);
        expect(calls[0].body).toMatchObject({
            idempotency_key: 'twitch:stream-live:1000:4242',
            body: expect.stringMatching(/for 1 h\./) as unknown,
        });
    });

    it('does nothing when off', async () => {
        const { service, calls } = setup([], {});
        service.resume(STREAM, CHANNEL);
        await service.streamOffline('1000');
        expect(calls).toEqual([]);
    });
});

describe('DISCORD_* environment', () => {
    it('needs the token and the URL together', () => {
        expect(() => testEnvService({ DISCORD_BOT_URL: 'http://discord-bot.test' })).toThrow(
            /DISCORD_INTERNAL_API_TOKEN: is required when DISCORD_BOT_URL is set/,
        );
        expect(() => testEnvService({ DISCORD_INTERNAL_API_TOKEN: 't'.repeat(40) })).toThrow(
            /DISCORD_BOT_URL: is required when DISCORD_INTERNAL_API_TOKEN is set/,
        );
        expect(() => testEnvService({ ...DISCORD, DISCORD_INTERNAL_API_TOKEN: 'short' })).toThrow(
            /at least 32 characters/,
        );
        expect(
            testEnvService({ DISCORD_BOT_URL: '  ', DISCORD_INTERNAL_API_TOKEN: '' }).get(
                'DISCORD_BOT_URL',
            ),
        ).toBeUndefined();
    });
});
