import { EntityManager } from '@mikro-orm/postgresql';
import { Global, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { EnvService } from '../../config/env.service';
import { TwitchBotAuth, TwitchStreamerAuth, TwitchUser, TwitchUserRegistered } from '../../entities';
import { FakeEntityManager, fakeFetch, testEnvService } from '../../../test/helpers';
import { AuthModule } from './auth.module';
import { BOT_SCOPES, STREAMER_SCOPES } from './twitch-scopes';

const STATE = 'state-from-cookie';

function helixUser(id: string, login: string) {
    return {
        id,
        login,
        display_name: login.toUpperCase(),
        profile_image_url: `https://cdn.test/${login}.png`,
        created_at: '2016-01-02T03:04:05Z',
    };
}

/** Parse `Set-Cookie` into name → raw header, so attributes can be asserted. */
function setCookies(res: request.Response): Record<string, string> {
    const header = res.headers['set-cookie'] as unknown as string[] | undefined;
    return Object.fromEntries((header ?? []).map(cookie => [cookie.split('=')[0], cookie]));
}

function cookieValue(raw: string): string {
    return raw.split(';')[0].split('=').slice(1).join('=');
}

describe('Twitch OAuth flows (HTTP, Twitch mocked at fetch)', () => {
    let app: INestApplication;
    let em: FakeEntityManager;
    let twitchUser = helixUser('42', 'viewer');
    let fetchMock: ReturnType<typeof fakeFetch>;

    beforeEach(async () => {
        em = new FakeEntityManager();
        twitchUser = helixUser('42', 'viewer');
        fetchMock = fakeFetch({
            'https://id.twitch.tv/oauth2/token': () => ({
                body: {
                    access_token: 'twitch-access',
                    refresh_token: 'twitch-refresh',
                    expires_in: 14_000,
                    scope: ['chat:read'],
                    token_type: 'bearer',
                },
            }),
            'https://api.twitch.tv/helix/users': () => ({ body: { data: [twitchUser] } }),
        });
        vi.stubGlobal('fetch', fetchMock.fn);

        @Global()
        @Module({
            providers: [
                { provide: EnvService, useValue: testEnvService() },
                { provide: EntityManager, useValue: em },
            ],
            exports: [EnvService, EntityManager],
        })
        class TestInfraModule {}

        const moduleRef = await Test.createTestingModule({ imports: [TestInfraModule, AuthModule] }).compile();
        app = moduleRef.createNestApplication();
        app.use(cookieParser());
        app.setGlobalPrefix('api');
        await app.init();
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        await app.close();
    });

    const http = () => request(app.getHttpServer());

    describe('start routes', () => {
        it('viewer login sets a state cookie and redirects to Twitch with the viewer scope', async () => {
            const res = await http().get('/api/auth/twitch/login').expect(302);
            const location = new URL(res.headers.location as string);
            const cookie = setCookies(res).brobot_oauth_viewer;

            expect(location.origin + location.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
            expect(location.searchParams.get('scope')).toBe('user_read');
            expect(location.searchParams.get('redirect_uri')).toBe(
                'https://admin.brobot.test/api/auth/twitch/callback',
            );
            expect(location.searchParams.get('force_verify')).toBeNull();
            expect(location.searchParams.get('state')).toBe(cookieValue(cookie));
            expect(cookie).toMatch(/HttpOnly/);
            expect(cookie).toMatch(/SameSite=Lax/);
            expect(cookie).toMatch(/Path=\/api\/auth\/twitch/);
        });

        it.each([
            ['streamer', STREAMER_SCOPES],
            ['bot', BOT_SCOPES],
        ] as const)('%s link asks for exactly the old scopes and forces the account picker', async (flow, scopes) => {
            const res = await http().get(`/api/auth/twitch/${flow}`).expect(302);
            const location = new URL(res.headers.location as string);
            expect(location.searchParams.get('scope')).toBe(scopes.join(' '));
            expect(location.searchParams.get('force_verify')).toBe('true');
            expect(setCookies(res)[`brobot_oauth_${flow}`]).toBeDefined();
        });
    });

    describe('viewer callback', () => {
        it('creates the user, sets the JWT cookies and sends the browser to UI_URL', async () => {
            const res = await http()
                .get(`/api/auth/twitch/callback?code=abc&state=${STATE}`)
                .set('Cookie', [`brobot_oauth_viewer=${STATE}`])
                .set('Accept', 'text/html')
                .expect(302);

            expect(res.headers.location).toBe('https://brobot.test/');
            const cookies = setCookies(res);
            expect(cookies.accessToken).toMatch(/HttpOnly/);
            expect(cookies.accessToken).toMatch(/SameSite=Strict/);
            expect(cookies.refreshToken).toMatch(/HttpOnly/);
            expect(cookieValue(cookies.brobot_oauth_viewer)).toBe(''); // state is single-use

            const [user] = em.all(TwitchUser);
            expect(user).toMatchObject({ oauth_id: '42', display_name: 'VIEWER', roles: ['Viewer'] });
            expect(em.all(TwitchUserRegistered)[0]).toMatchObject({
                profile_image_url: 'https://cdn.test/viewer.png',
                scope: ['user_read'],
            });
            // The viewer flow stores no Twitch token.
            expect(em.all(TwitchStreamerAuth)).toHaveLength(0);
            expect(em.all(TwitchBotAuth)).toHaveLength(0);

            const tokenCall = fetchMock.calls.find(call => call.url.startsWith('https://id.twitch.tv/oauth2/token'));
            const form = new URLSearchParams(tokenCall?.init?.body as string);
            expect(form.get('grant_type')).toBe('authorization_code');
            expect(form.get('code')).toBe('abc');
            expect(form.get('redirect_uri')).toBe('https://admin.brobot.test/api/auth/twitch/callback');
        });

        it('returns the token pair as JSON to a client that asks for JSON, and the pair works', async () => {
            const res = await http()
                .get(`/api/auth/twitch/callback?code=abc&state=${STATE}`)
                .set('Cookie', [`brobot_oauth_viewer=${STATE}`])
                .set('Accept', 'application/json')
                .expect(200);

            expect(Object.keys(res.body as object).sort()).toEqual(['accessToken', 'refreshToken']);
            const { accessToken } = res.body as { accessToken: string };

            const status = await http()
                .get('/api/auth/twitch/status')
                .set('Authorization', `Bearer ${accessToken}`)
                .expect(200);
            expect(status.body).toEqual({
                oauthId: '42',
                displayName: 'VIEWER',
                roles: ['Viewer'],
                profileImageUrl: 'https://cdn.test/viewer.png',
                scope: ['user_read'],
            });
        });

        it('refuses a state that does not match the cookie, without calling Twitch', async () => {
            const res = await http()
                .get('/api/auth/twitch/callback?code=abc&state=forged')
                .set('Cookie', [`brobot_oauth_viewer=${STATE}`])
                .expect(302);
            expect(res.headers.location).toBe('https://brobot.test/?auth_error=invalid_state');
            expect(fetchMock.calls).toHaveLength(0);
            expect(setCookies(res).accessToken).toBeUndefined();
        });

        it('refuses a callback with no state cookie at all', async () => {
            const res = await http().get(`/api/auth/twitch/callback?code=abc&state=${STATE}`).expect(302);
            expect(res.headers.location).toBe('https://brobot.test/?auth_error=invalid_state');
        });

        it('reports a declined consent screen', async () => {
            const res = await http()
                .get(`/api/auth/twitch/callback?error=access_denied&state=${STATE}`)
                .set('Cookie', [`brobot_oauth_viewer=${STATE}`])
                .expect(302);
            expect(res.headers.location).toBe('https://brobot.test/?auth_error=access_denied');
        });

        it('keeps roles a returning user already has', async () => {
            em.insert(TwitchUser, { oauth_id: '42', display_name: 'old name', roles: ['Viewer', 'Admin'] });
            await http()
                .get(`/api/auth/twitch/callback?code=abc&state=${STATE}`)
                .set('Cookie', [`brobot_oauth_viewer=${STATE}`])
                .expect(302);
            expect(em.all(TwitchUser)).toHaveLength(1);
            expect(em.all(TwitchUser)[0]).toMatchObject({ display_name: 'VIEWER', roles: ['Viewer', 'Admin'] });
        });
    });

    describe('streamer / bot callbacks', () => {
        it('stores the streamer token in twitch_streamer_auth and grants StreamerAuth', async () => {
            twitchUser = helixUser('1000', 'trama');
            const res = await http()
                .get(`/api/auth/twitch/streamer/callback?code=abc&state=${STATE}`)
                .set('Cookie', [`brobot_oauth_streamer=${STATE}`])
                .expect(302);

            expect(res.headers.location).toBe('https://brobot.test/?linked=streamer');
            expect(em.all(TwitchStreamerAuth)).toHaveLength(1);
            expect(em.all(TwitchBotAuth)).toHaveLength(0);
            expect(em.all(TwitchStreamerAuth)[0]).toMatchObject({
                access_token: 'twitch-access',
                refresh_token: 'twitch-refresh',
                expiry_seconds: 14_000,
                scope: ['chat:read'],
            });
            expect(em.all(TwitchUser)[0].roles).toEqual(['Viewer', 'StreamerAuth']);
        });

        it('never touches the browser session — linking the bot keeps you signed in as yourself', async () => {
            twitchUser = helixUser('2000', 'bro_____bot');
            const res = await http()
                .get(`/api/auth/twitch/bot/callback?code=abc&state=${STATE}`)
                .set('Cookie', [`brobot_oauth_bot=${STATE}`, 'accessToken=the-streamers-own-session'])
                .expect(302);

            expect(res.headers.location).toBe('https://brobot.test/?linked=bot');
            const cookies = setCookies(res);
            expect(cookies.accessToken).toBeUndefined();
            expect(cookies.refreshToken).toBeUndefined();
            expect(em.all(TwitchBotAuth)).toHaveLength(1);
            expect(em.all(TwitchUser)[0].roles).toEqual(['Viewer', 'BotAuth']);
        });

        it.each(['streamer', 'bot'])('refuses any account but the configured one for %s, storing nothing', async flow => {
            twitchUser = helixUser('666', 'someone_else');
            const res = await http()
                .get(`/api/auth/twitch/${flow}/callback?code=abc&state=${STATE}`)
                .set('Cookie', [`brobot_oauth_${flow}=${STATE}`])
                .expect(302);

            expect(res.headers.location).toBe('https://brobot.test/?auth_error=wrong_account');
            expect(em.all(TwitchStreamerAuth)).toHaveLength(0);
            expect(em.all(TwitchBotAuth)).toHaveLength(0);
            expect(em.all(TwitchUser)).toHaveLength(0);
        });

        it('answers 403 JSON for the wrong account when JSON was asked for', async () => {
            twitchUser = helixUser('666', 'someone_else');
            await http()
                .get(`/api/auth/twitch/streamer/callback?code=abc&state=${STATE}`)
                .set('Cookie', [`brobot_oauth_streamer=${STATE}`])
                .set('Accept', 'application/json')
                .expect(403);
        });

        it('sends the browser back with twitch_unavailable when Twitch is down', async () => {
            vi.stubGlobal('fetch', async () => {
                throw new TypeError('fetch failed');
            });
            const res = await http()
                .get(`/api/auth/twitch/callback?code=abc&state=${STATE}`)
                .set('Cookie', [`brobot_oauth_viewer=${STATE}`])
                .expect(302);
            expect(res.headers.location).toBe('https://brobot.test/?auth_error=twitch_unavailable');
        });
    });

    describe('refresh and logout', () => {
        async function signIn(): Promise<{ accessToken: string; refreshToken: string }> {
            const res = await http()
                .get(`/api/auth/twitch/callback?code=abc&state=${STATE}`)
                .set('Cookie', [`brobot_oauth_viewer=${STATE}`])
                .set('Accept', 'application/json')
                .expect(200);
            return res.body as { accessToken: string; refreshToken: string };
        }

        it('bearer mode: a refresh token in the body gets a new pair in the body', async () => {
            const { refreshToken } = await signIn();
            const res = await http().post('/api/auth/twitch/refresh').send({ refreshToken }).expect(200);
            expect(Object.keys(res.body as object).sort()).toEqual(['accessToken', 'refreshToken']);
        });

        it('cookie mode: new cookies, no tokens in the body', async () => {
            const { refreshToken } = await signIn();
            const res = await http()
                .post('/api/auth/twitch/refresh')
                .set('Cookie', [`refreshToken=${refreshToken}`])
                .expect(200);
            expect(res.text).toBe('');
            expect(setCookies(res).accessToken).toMatch(/HttpOnly/);
        });

        it('is also served at /api/auth/refresh, the path ngx-auth excludes from its retry', async () => {
            const { refreshToken } = await signIn();
            await http().post('/api/auth/refresh').send({ refreshToken }).expect(200);
        });

        it('refuses an access token presented as a refresh token, and clears cookies', async () => {
            const { accessToken } = await signIn();
            const res = await http().post('/api/auth/twitch/refresh').send({ refreshToken: accessToken }).expect(401);
            expect(cookieValue(setCookies(res).accessToken)).toBe('');
        });

        it('refuses a refresh with no token', async () => {
            await http().post('/api/auth/twitch/refresh').expect(401);
        });

        it('refuses a refresh token as an access token', async () => {
            const { refreshToken } = await signIn();
            await http().get('/api/auth/twitch/status').set('Authorization', `Bearer ${refreshToken}`).expect(401);
        });

        it('logout clears both cookies', async () => {
            const res = await http().post('/api/auth/twitch/logout').expect(204);
            const cookies = setCookies(res);
            expect(cookieValue(cookies.accessToken)).toBe('');
            expect(cookieValue(cookies.refreshToken)).toBe('');
        });

        it('status without a session is 401', async () => {
            await http().get('/api/auth/twitch/status').expect(401);
        });
    });
});
