import type { EntityManager } from '@mikro-orm/postgresql';
import { RefreshingAuthProvider } from '@twurple/auth';
import { TwitchBotAuth, TwitchStreamerAuth, TwitchUser } from '../../entities';
import { FakeEntityManager, testEnvService } from '../../../test/helpers';
import { TwitchTokenStoreService } from './twitch-token-store.service';

const token = (accessToken: string) => ({
    accessToken,
    refreshToken: `${accessToken}-refresh`,
    scope: ['chat:read'],
    expiresIn: 3600,
    obtainmentTimestamp: 1_700_000_000_000,
});

describe('TwitchTokenStoreService', () => {
    let em: FakeEntityManager;
    let store: TwitchTokenStoreService;

    beforeEach(() => {
        em = new FakeEntityManager();
        em.insert(TwitchUser, { oauth_id: '1000', display_name: 'Streamer', roles: ['Viewer'] });
        em.insert(TwitchUser, { oauth_id: '2000', display_name: 'Bot', roles: ['Viewer'] });
        store = new TwitchTokenStoreService(em as unknown as EntityManager, testEnvService());
    });

    it('writes a streamer token to twitch_streamer_auth and never to twitch_bot_auth (the old refresh bug)', async () => {
        await store.save('bot', '2000', token('bot-1'));
        await store.save('streamer', '1000', token('streamer-1'));

        expect(em.all(TwitchStreamerAuth).map(row => row.access_token)).toEqual(['streamer-1']);
        expect(em.all(TwitchBotAuth).map(row => row.access_token)).toEqual(['bot-1']);
    });

    it('replaces rather than duplicates on a second save, keeping the refresh token if one is omitted', async () => {
        await store.save('streamer', '1000', token('streamer-1'));
        await store.save('streamer', '1000', { ...token('streamer-2'), refreshToken: null, expiresIn: null });

        expect(em.all(TwitchStreamerAuth)).toHaveLength(1);
        expect(em.all(TwitchStreamerAuth)[0]).toMatchObject({
            access_token: 'streamer-2',
            refresh_token: 'streamer-1-refresh',
            expiry_seconds: 0,
        });
    });

    it('loads each kind for its configured account only', async () => {
        await store.save('streamer', '1000', token('streamer-1'));

        await expect(store.load('streamer')).resolves.toEqual({ oauthId: '1000', token: token('streamer-1') });
        await expect(store.load('bot')).resolves.toBeNull();
    });

    it('builds a Twurple provider from the stored token, or null before the flow has been completed', async () => {
        await expect(store.createAuthProvider('bot')).resolves.toBeNull();

        await store.save('bot', '2000', token('bot-1'));
        const provider = await store.createAuthProvider('bot', ['chat']);
        expect(provider).toBeInstanceOf(RefreshingAuthProvider);
        expect(provider?.hasUser('2000')).toBe(true);
        expect(provider?.getIntentsForUser('2000')).toEqual(['chat']);
    });
});
