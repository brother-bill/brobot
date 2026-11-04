import { fakeChat } from '../../../test/bot-fakes';
import { testEnvService } from '../../../test/helpers';
import { EventSubService, EVENTSUB_PATH_PREFIX, type NestExpressInstance } from './eventsub.service';
import { GoLiveService, type ChannelInfo, type StreamOnline } from './go-live/go-live.service';
import type { Redemption } from './redeems/redemption';
import type { RedemptionsService } from './redeems/redemptions.service';

type Handler = (event: Record<string, unknown>) => void;

const twurple = vi.hoisted(() => ({
    stream: null as null | Record<string, unknown>,
    middleware: null as null | {
        config: Record<string, unknown>;
        appliedTo: unknown;
        ready: boolean;
        subscriptions: { kind: string; user: string; handler: Handler }[];
    },
}));

vi.mock('@twurple/api', () => ({
    ApiClient: class {
        streams = { getStreamByUserId: async () => twurple.stream };
    },
}));
vi.mock('@twurple/auth', () => ({ AppTokenAuthProvider: class {} }));
vi.mock('@twurple/eventsub-http', () => ({
    EventSubMiddleware: class {
        private readonly record;

        constructor(config: Record<string, unknown>) {
            this.record = { config, appliedTo: null as unknown, ready: false, subscriptions: [] as { kind: string; user: string; handler: Handler }[] };
            twurple.middleware = this.record;
        }

        apply(app: unknown) {
            this.record.appliedTo = app;
        }

        async markAsReady() {
            this.record.ready = true;
        }

        onSubscriptionCreateSuccess() {
            return undefined;
        }

        onSubscriptionCreateFailure() {
            return undefined;
        }

        onRevoke() {
            return undefined;
        }

        onChannelRedemptionAdd(user: string, handler: Handler) {
            this.record.subscriptions.push({ kind: 'redemption', user, handler });
        }

        onChannelRaidTo(user: string, handler: Handler) {
            this.record.subscriptions.push({ kind: 'raid', user, handler });
        }

        onStreamOnline(user: string, handler: Handler) {
            this.record.subscriptions.push({ kind: 'stream-online', user, handler });
        }

        onStreamOffline(user: string, handler: Handler) {
            this.record.subscriptions.push({ kind: 'stream-offline', user, handler });
        }
    },
}));

function setup(env: Record<string, string>) {
    const { chat, said } = fakeChat();
    const handled: Redemption[] = [];
    const redemptions = { handle: async (redemption: Redemption) => void handled.push(redemption) };
    const goLive = new GoLiveService(testEnvService(env));
    const live: StreamOnline[] = [];
    const ended: string[] = [];
    const resumed: [StreamOnline, ChannelInfo | null][] = [];
    goLive.streamOnline = async stream => void live.push(stream);
    goLive.streamOffline = async broadcasterId => void ended.push(broadcasterId);
    goLive.resume = (stream, info) => void resumed.push([stream, info]);
    const service = new EventSubService(testEnvService(env), redemptions as unknown as RedemptionsService, chat, goLive);
    return { service, said, handled, live, ended, resumed };
}

describe('EventSubService', () => {
    beforeEach(() => {
        twurple.middleware = null;
        twurple.stream = null;
    });

    it('does nothing unless both the bot and EventSub are switched on', async () => {
        const app = {} as NestExpressInstance;
        const envs: Record<string, string>[] = [{}, { TWITCH_EVENTSUB_ENABLED: 'true' }, { TWITCH_BOT_ENABLED: 'true' }];
        for (const env of envs) {
            const { service } = setup(env);
            service.apply(app);
            await service.subscribe();
        }
        expect(twurple.middleware).toBeNull();
    });

    it('mounts the webhook on the app under /twitch, then subscribes to redemptions and raids for the streamer', async () => {
        const { service, said, handled } = setup({ TWITCH_EVENTSUB_ENABLED: 'true', TWITCH_BOT_ENABLED: 'true' });
        const app = {} as NestExpressInstance;
        service.apply(app);

        const middleware = twurple.middleware;
        if (!middleware) throw new Error('middleware not created');
        expect(middleware.appliedTo).toBe(app);
        expect(middleware.config).toMatchObject({
            hostName: 'admin.brobot.test',
            pathPrefix: EVENTSUB_PATH_PREFIX,
            secret: 'eventsub-secret',
            strictHostCheck: true,
        });

        await service.subscribe();
        expect(middleware.ready).toBe(true);
        // DISCORD_BOT_URL is unset, so the stream going live is not subscribed to.
        expect(middleware.subscriptions.map(sub => [sub.kind, sub.user])).toEqual([
            ['redemption', '1000'],
            ['raid', '1000'],
        ]);

        middleware.subscriptions[0].handler({
            id: 'r1',
            rewardId: 'w1',
            rewardTitle: 'Pokemon Roar',
            userId: '77',
            userName: 'Ash',
            userDisplayName: 'Ash',
            input: '',
        });
        middleware.subscriptions[1].handler({ raidingBroadcasterName: 'misty' });
        await new Promise(resolve => setImmediate(resolve));

        expect(handled).toEqual([
            { id: 'r1', rewardId: 'w1', rewardTitle: 'Pokemon Roar', userId: '77', login: 'ash', displayName: 'Ash', input: '' },
        ]);
        expect(said).toEqual(['Check out the MAGNIFICENT misty at twitch.tv/misty . So cool!']);
    });

    const discord = { DISCORD_BOT_URL: 'http://discord-bot.test', DISCORD_INTERNAL_API_TOKEN: 't'.repeat(40) };

    it('subscribes to the stream going live and ending only when the Discord announcement is configured', async () => {
        const { service, live, ended, resumed } = setup({ TWITCH_EVENTSUB_ENABLED: 'true', TWITCH_BOT_ENABLED: 'true', ...discord });
        service.apply({} as NestExpressInstance);
        await service.subscribe();

        const middleware = twurple.middleware;
        if (!middleware) throw new Error('middleware not created');
        const online = middleware.subscriptions.find(sub => sub.kind === 'stream-online');
        expect(online?.user).toBe('1000');
        const startDate = new Date('2026-11-04T18:00:00Z');
        online?.handler({ id: 's1', type: 'live', broadcasterId: '1000', broadcasterName: 'trama', broadcasterDisplayName: 'Trama', startDate });
        expect(live).toEqual([
            { streamId: 's1', type: 'live', broadcasterId: '1000', login: 'trama', displayName: 'Trama', startedAt: startDate },
        ]);

        const offline = middleware.subscriptions.find(sub => sub.kind === 'stream-offline');
        expect(offline?.user).toBe('1000');
        offline?.handler({ broadcasterId: '1000', broadcasterName: 'trama', broadcasterDisplayName: 'Trama' });
        expect(ended).toEqual(['1000']);
        // Not on air at startup: nothing to resume.
        expect(resumed).toEqual([]);
    });

    it('remembers a stream already on air at startup, so its end is marked', async () => {
        const startDate = new Date('2026-11-04T18:00:00Z');
        twurple.stream = {
            id: 's1',
            type: 'live',
            userId: '1000',
            userName: 'trama',
            userDisplayName: 'Trama',
            startDate,
            title: 'Horror night',
            gameName: 'Phasmophobia',
        };
        const { service, resumed } = setup({ TWITCH_EVENTSUB_ENABLED: 'true', TWITCH_BOT_ENABLED: 'true', ...discord });
        service.apply({} as NestExpressInstance);
        await service.subscribe();
        expect(resumed).toEqual([
            [
                { streamId: 's1', type: 'live', broadcasterId: '1000', login: 'trama', displayName: 'Trama', startedAt: startDate },
                { title: 'Horror night', gameName: 'Phasmophobia' },
            ],
        ]);
    });
});
