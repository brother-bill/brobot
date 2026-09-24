import { MikroORM } from '@mikro-orm/core';
import type { Options } from '@mikro-orm/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import WebSocket from 'ws';
import { RAW_TEST_ENV } from '../test/helpers';

/**
 * Boots the REAL AppModule — every module, guard and gateway as production
 * wires them — with only the database connection switched off. A DI break is
 * a runtime failure that typecheck cannot see; this is where it shows up
 * instead of at deploy.
 */
describe('AppModule boot', () => {
    let app: NestExpressApplication;
    let baseUrl: string;
    const savedEnv = { ...process.env };

    beforeAll(async () => {
        Object.assign(process.env, RAW_TEST_ENV, { NODE_ENV: 'test' });
        const init = MikroORM.init.bind(MikroORM);
        vi.spyOn(MikroORM, 'init').mockImplementation((options?: Options) => init({ ...options, connect: false }));

        // Imported after the env is set: ConfigModule validates at import time.
        const { AppModule } = await import('./app.module');
        const { configureApp } = await import('./bootstrap');
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication<NestExpressApplication>();
        configureApp(app);
        await app.listen(0, '127.0.0.1');
        baseUrl = `127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await app.close();
        vi.restoreAllMocks();
        process.env = savedEnv;
    });

    const http = () => request(app.getHttpServer());

    it('serves both health endpoints without a database', async () => {
        await http().get('/api/health/live').expect(200).expect(res => expect(res.body.status).toBe('live'));
        await http()
            .get('/api/health')
            .expect(200)
            .expect(res => expect(res.body).toMatchObject({ status: 'ok', service: 'brobot' }));
    });

    it('lists commands publicly and refuses to toggle one without a session', async () => {
        const list = await http().get('/api/commands').expect(200);
        expect((list.body as { name: string }[]).map(command => command.name)).toContain('quack');
        await http().post('/api/commands').send({ name: 'quack', enabled: true }).expect(401);
    });

    it('answers CORS for a listed origin only', async () => {
        const allowed = await http().get('/api/health/live').set('Origin', 'https://brobot.test');
        expect(allowed.headers['access-control-allow-origin']).toBe('https://brobot.test');
        expect(allowed.headers['access-control-allow-credentials']).toBe('true');

        const refused = await http().get('/api/health/live').set('Origin', 'https://evil.test');
        expect(refused.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('sends helmet headers', async () => {
        const res = await http().get('/api/health/live');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('starts the viewer flow', async () => {
        const res = await http().get('/api/auth/twitch/login').expect(302);
        expect(res.headers.location).toMatch(/^https:\/\/id\.twitch\.tv\/oauth2\/authorize\?/);
    });

    it('validates the team search login and rate-limits it per client', async () => {
        await http().get('/api/pokemon/teams?login=../../etc').expect(400);
        // 10 per minute; one request above has already been counted.
        for (let i = 0; i < 9; i++) await http().get('/api/pokemon/teams?login=../x').expect(400);
        await http().get('/api/pokemon/teams?login=../x').expect(429);
        // Other routes keep their own, larger budget.
        await http().get('/api/commands').expect(200);
    });

    it('guards the internal transfer surface with the service token (no routes yet → 404 once past CORS)', async () => {
        await http().get('/api/internal/transfer').expect(404);
    });

    describe('/api/ashketchum', () => {
        function connect(headers: Record<string, string>): Promise<string> {
            return new Promise(resolve => {
                const socket = new WebSocket(`ws://${baseUrl}/api/ashketchum`, { headers });
                socket.on('open', () => {
                    socket.close();
                    resolve('open');
                });
                socket.on('unexpected-response', (_req, res) => resolve(`http ${res.statusCode}`));
                socket.on('error', error => resolve(`error ${error.message}`));
            });
        }

        it('refuses an upgrade without the secret, before a socket exists', async () => {
            await expect(connect({})).resolves.toBe('http 401');
            await expect(connect({ token: 'wrong' })).resolves.toBe('http 401');
        });

        it('accepts the legacy token header and a Bearer header', async () => {
            await expect(connect({ token: RAW_TEST_ENV.WS_SECRET })).resolves.toBe('open');
            await expect(connect({ Authorization: `Bearer ${RAW_TEST_ENV.WS_SECRET}` })).resolves.toBe('open');
        });
    });

    it('serves the stream overlay socket at /api/admin-ui without a secret', async () => {
        const opened = await new Promise<string>(resolve => {
            const socket = new WebSocket(`ws://${baseUrl}/api/admin-ui`);
            socket.on('open', () => {
                socket.close();
                resolve('open');
            });
            socket.on('unexpected-response', (_req, res) => resolve(`http ${res.statusCode}`));
            socket.on('error', error => resolve(`error ${error.message}`));
        });
        expect(opened).toBe('open');
    });
});
