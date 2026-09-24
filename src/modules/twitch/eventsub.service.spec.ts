import { fakeChat } from '../../../test/bot-fakes';
import { testEnvService } from '../../../test/helpers';
import { EventSubService, EVENTSUB_PATH_PREFIX, type NestExpressInstance } from './eventsub.service';
import type { Redemption } from './redeems/redemption';
import type { RedemptionsService } from './redeems/redemptions.service';

type Handler = (event: Record<string, string>) => void;

const twurple = vi.hoisted(() => ({
    middleware: null as null | {
        config: Record<string, unknown>;
        appliedTo: unknown;
        ready: boolean;
        subscriptions: { kind: string; user: string; handler: Handler }[];
    },
}));

vi.mock('@twurple/api', () => ({ ApiClient: class {} }));
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
    },
}));

function setup(env: Record<string, string>) {
    const { chat, said } = fakeChat();
    const handled: Redemption[] = [];
    const redemptions = { handle: async (redemption: Redemption) => void handled.push(redemption) };
    const service = new EventSubService(testEnvService(env), redemptions as unknown as RedemptionsService, chat);
    return { service, said, handled };
}

describe('EventSubService', () => {
    beforeEach(() => {
        twurple.middleware = null;
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
        expect(middleware.subscriptions).toEqual([]);

        await service.subscribe();
        expect(middleware.ready).toBe(true);
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
});
