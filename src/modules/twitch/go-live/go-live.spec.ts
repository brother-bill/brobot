import { testEnvService } from '../../../../test/helpers';
import type { AnnounceFetch } from './discord-announce';
import {
    GO_LIVE_RETRY_DELAYS_MS,
    GoLiveService,
    goLiveAnnouncement,
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
    it('announces the title, category, preview and link, pinging the follower role, once per broadcast', () => {
        expect(goLiveAnnouncement(STREAM, CHANNEL, 'home')).toEqual({
            server: 'home',
            project: 'brobot',
            kind: 'stream-live',
            title: 'Trama is live: Horror night',
            body: 'Playing **Phasmophobia** on Twitch.\n[Watch the stream](https://www.twitch.tv/trama)',
            url: 'https://www.twitch.tv/trama',
            image: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_trama-1280x720.jpg?stream=4242',
            ping: 'role',
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
