import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MikroORM } from '@mikro-orm/core';
import type { Options } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { GATEWAY_OPTIONS } from '@nestjs/websockets/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import Ajv2020 from 'ajv/dist/2020';
import type { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import request from 'supertest';
import { FakeEntityManager, fakeFetch, RAW_TEST_ENV } from '../../test/helpers';
import { GLOBAL_PREFIX } from '../bootstrap';
import {
    CommandSetting,
    Pokemon,
    PokemonBattleOutcome,
    PokemonTeam,
    TwitchUser,
} from '../entities';
import { JwtAuthGuard } from '../modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../modules/auth/guards/roles.guard';
import { stateCookieName } from '../modules/auth/oauth-state';
import { TokenService } from '../modules/auth/token.service';
import { TransferLog } from '../modules/transfer/entities/transfer-log.entity';
import { ServiceTokenGuard } from '../modules/transfer/service-token.guard';
import { EVENTSUB_PATH_PREFIX } from '../modules/twitch/eventsub.service';
import { OVERLAY_SOCKET_PATH } from '../modules/twitch/overlay-events';
import { STREAMER_SOCKET_PATH } from '../modules/twitch/streamer-events';
import { brobotServers } from './security';
import {
    appControllers,
    appGlobalGuards,
    renderServedRoutes,
    SERVED_ROUTES_COMMAND,
    SERVED_ROUTES_FILE,
    SERVED_ROUTES_WRITE_ENV,
    servedRoutes,
} from './served-routes';
import type { GuardFacts, HandlerFacts, ServedRoutes } from './served-routes';

/**
 * Served-routes parity and response conformance
 * (libs/contracts/docs/publishing-a-contract.md §4 and §5).
 *
 * Boots the real AppModule, as app.boot.spec.ts does, with the database faked
 * behind the EntityManager and Twitch faked at `fetch`. It reads what Nest
 * serves into `served-routes/v1` and runs singularity's shared checker
 * (`libs/contracts/scripts/served-routes-check.mjs`) against the committed
 * openapi.json, failing on any error finding. Then every response this file
 * gets, success and error, is validated against the document's schema for
 * its status with Ajv 2020, and each of the 24 operations is called at least
 * once.
 */

// ── what the metadata cannot say ────────────────────────────────────────────

/**
 * Paths brobot serves that are, on purpose, not operations of openapi.json.
 * None is a Nest controller route, so none is in the served routes either;
 * each is held to where it is really mounted below.
 */
const OUTSIDE_THE_DOCUMENT = [
    {
        path: EVENTSUB_PATH_PREFIX,
        kind: 'eventsub',
        why:
            "Twitch's EventSub webhook. twurple's EventSubMiddleware mounts it on the Express app " +
            "itself, outside the /api prefix and Nest's router, so no metadata lists it; its " +
            "contract is Twitch's EventSub protocol (signed by EVENT_SUB_SECRET), not brobot's.",
    },
    {
        path: STREAMER_SOCKET_PATH,
        kind: 'websocket',
        why:
            "StreamerGateway, the streamer's hotkey socket (WS_SECRET). A WebSocket upgrade, not " +
            'an HTTP operation: OpenAPI 3.1 cannot describe its frames.',
    },
    {
        path: OVERLAY_SOCKET_PATH,
        kind: 'websocket',
        why:
            "OverlayGateway, the stream overlay's socket. A WebSocket upgrade, not an HTTP " +
            'operation: OpenAPI 3.1 cannot describe its frames.',
    },
] as const;

const notSkipped = (controller: Type, handler: object) =>
    // @SkipThrottle() leaves `THROTTLER:SKIP<name>` (the name is `default`, app.module.ts).
    !Reflect.getMetadata('THROTTLER:SKIPdefault', handler) &&
    !Reflect.getMetadata('THROTTLER:SKIPdefault', controller);

/** Every guard a route runs. Cookies are not headers here (served-routes.ts). */
const GUARDS = new Map<Type, GuardFacts>([
    [ThrottlerGuard, { headers: [], refuses: [429], guards: notSkipped }],
    [JwtAuthGuard, { headers: ['authorization'], refuses: [401] }],
    [RolesGuard, { headers: [], refuses: [401, 403] }],
    [ServiceTokenGuard, { headers: ['authorization'], refuses: [401] }],
]);

/** What each handler, or a service it calls, answers itself; and what one taking `@Req()` reads. */
const HANDLERS: Record<string, HandlerFacts> = {
    // The start routes redirect through @Res().
    'AuthController.login': { sends: [302] },
    'AuthController.streamer': { sends: [302] },
    'AuthController.bot': { sends: [302] },
    // The callbacks read Accept (`wantsJson`) and the state cookie, and answer through @Res().
    'AuthController.callback': { reads: ['accept'], sends: [200, 302, 401, 502] },
    'AuthController.streamerCallback': { reads: ['accept'], sends: [200, 302, 401, 403, 502] },
    'AuthController.botCallback': { reads: ['accept'], sends: [200, 302, 401, 403, 502] },
    // The refreshes read the refreshToken cookie only, and refuse with 401.
    'AuthController.refresh': { reads: [], sends: [401] },
    'AuthRefreshAliasController.refresh': { reads: [], sends: [401] },
    'AuthController.status': { sends: [401] },
    'CommandsController.setEnabled': { sends: [404] },
    'PokemonController.team': { sends: [404, 502] },
    'TransferController.depart': { sends: [403, 404, 409] },
    'TransferController.return': { sends: [403, 404, 409] },
    // HorrorModeService.setMode parses `mode` itself.
    'HorrorModeController.set': { sends: [400] },
};

// ── the shared checker ──────────────────────────────────────────────────────

interface Finding {
    severity: 'error' | 'warning';
    where: string;
    message: string;
}

/** What this spec uses of `served-routes-check.mjs` (plain ESM with JSDoc types). */
interface ServedRoutesCheck {
    validateServedRoutes(value: unknown): string[];
    checkServedRoutes(served: ServedRoutes, document: Record<string, unknown>): Finding[];
}

const SUPERPROJECT = resolve(__dirname, '../../../..');
const CHECKER = resolve(SUPERPROJECT, 'libs/contracts/scripts/served-routes-check.mjs');
const SERVED_ROUTES_SCHEMA = resolve(
    SUPERPROJECT,
    'libs/contracts/scripts/served-routes.schema.json',
);
/** The committed file singularity's contract-check.yml checks (brobot's .github/workflows/contract.yml). */
const SERVED_ROUTES_PATH = resolve(__dirname, '../..', SERVED_ROUTES_FILE);

// ── the document ────────────────────────────────────────────────────────────

interface MediaType {
    schema?: unknown;
}
interface ResponseObject {
    content?: Record<string, MediaType>;
    headers?: Record<string, { required?: boolean; schema?: unknown }>;
}
interface Operation {
    operationId: string;
    responses: Record<string, ResponseObject>;
}
type Document = { paths: Record<string, Record<string, Operation>> } & Record<string, unknown>;

const DOCUMENT_ID = 'urn:contract:brobot';
const document = JSON.parse(
    readFileSync(resolve(__dirname, '../../openapi.json'), 'utf8'),
) as Document;

const operations = new Map(
    Object.entries(document.paths).flatMap(([path, item]) =>
        Object.entries(item).map(
            ([method, operation]) => [operation.operationId, { path, method, operation }] as const,
        ),
    ),
);

/** A JSON pointer token: `/` is `~1`, `~` is `~0`. */
const token = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');

// ── fakes ───────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const keyOf = (value: unknown): unknown =>
    value && typeof value === 'object' ? (value as Row).oauth_id ?? (value as Row).id : value;
const matchesRow = (row: Row, where: Row) =>
    Object.entries(where).every(([field, expected]) => keyOf(row[field]) === keyOf(expected));

/** The shared fake plus what the read, transfer and horror services call: `find`, `transactional`, ids for the transfer log. */
class AppFakeEntityManager extends FakeEntityManager {
    private sequence = 0;

    async find<T>(entity: new () => T, where: Row, options?: { limit?: number }): Promise<T[]> {
        return this.all(entity)
            .filter(row => matchesRow(row as Row, where))
            .slice(0, options?.limit);
    }

    override async findOne<T>(entity: new () => T, where: Row): Promise<T | null> {
        return this.all(entity).find(row => matchesRow(row as Row, where)) ?? null;
    }

    async transactional<T>(work: (em: this) => Promise<T>): Promise<T> {
        const result = await work(this);
        await this.flush();
        return result;
    }

    override create<T extends object>(entity: new () => T, data: Partial<T>): T {
        const row = super.create(entity, data);
        if (row instanceof TransferLog) row.id = ++this.sequence;
        return row;
    }
}

const VIEWER = '42';
const ADMIN = '43';
const REGISTER = '11111111-1111-4111-8111-111111111111';
const SERVICE = `Bearer ${RAW_TEST_ENV.BROBOT_SERVICE_TOKEN}`;

function helixUser(id: string, login: string) {
    return {
        id,
        login,
        display_name: login.toUpperCase(),
        profile_image_url: `https://cdn.test/${login}.png`,
        created_at: '2016-01-02T03:04:05Z',
    };
}

describe('openapi.json against what brobot serves', () => {
    const em = new AppFakeEntityManager();
    const savedEnv = { ...process.env };
    let app: NestExpressApplication;
    let served: ServedRoutes;
    let checker: ServedRoutesCheck;
    let pikachu: Pokemon;
    /** Who Twitch's users endpoint answers: by the user's token (`null`: a 500), and by login. */
    let helix: {
        byToken: ReturnType<typeof helixUser> | null;
        byLogin: Record<string, ReturnType<typeof helixUser>>;
    };

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema(document, DOCUMENT_ID);
    const validators = new Map<string, ValidateFunction>();
    const validator = (pointer: string) => {
        let validate = validators.get(pointer);
        if (!validate) {
            validate = ajv.compile({ $ref: `${DOCUMENT_ID}#${pointer}` });
            validators.set(pointer, validate);
        }
        return validate;
    };

    /** Every status each operation answered in this file. */
    const answered = new Map<string, Set<number>>();

    beforeAll(async () => {
        Object.assign(process.env, RAW_TEST_ENV, { NODE_ENV: 'test' });
        const init = MikroORM.init.bind(MikroORM);
        vi.spyOn(MikroORM, 'init').mockImplementation((options?: Options) =>
            init({ ...options, connect: false }),
        );

        // Imported after the env is set: ConfigModule validates at import time.
        const { AppModule } = await import('../app.module');
        const { configureApp } = await import('../bootstrap');
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(EntityManager)
            .useValue(em)
            .compile();
        app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
        configureApp(app);
        await app.listen(0, '127.0.0.1');

        served = servedRoutes({
            service: 'brobot',
            controllers: appControllers(app),
            globalGuards: appGlobalGuards(app),
            guards: GUARDS,
            handlers: HANDLERS,
        });
        checker = (await import(pathToFileURL(CHECKER).href)) as ServedRoutesCheck;
    });

    afterAll(async () => {
        await app.close();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        process.env = savedEnv;
    });

    beforeEach(() => {
        em.reset();
        em.insert(TwitchUser, { oauth_id: VIEWER, display_name: 'Viewer' });
        const owner = em.insert(TwitchUser, {
            oauth_id: ADMIN,
            display_name: 'Admin',
            roles: ['Viewer', 'Admin'],
        });
        em.insert(CommandSetting, { name: 'quack', enabled: true, updated_by: 'seed' });
        em.insert(PokemonBattleOutcome, {
            outcome: ['Pikachu used Thunderbolt!'],
            updated_date: new Date('2026-11-01T20:00:00Z'),
        });
        pikachu = em.insert(Pokemon, {
            name: 'Pikachu',
            name_id: 'pikachu',
            slot: 1,
            level: 40,
            shiny: true,
            wins: 3,
            losses: 1,
            draws: 0,
            item: '',
            moves: ['thunderbolt', 'quickattack'],
            dex_num: 25,
            color: 'Yellow',
            types: ['Electric'],
            gender: 'F',
            nature: 'Jolly',
            ability: 'Static',
            twitch_user: owner,
            created_date: new Date('2022-12-01T10:00:00Z'),
            updated_date: new Date('2022-12-02T10:00:00Z'),
        });
        const team = em.insert(PokemonTeam, { twitch_user: owner });
        // The fake loads no relations: the team's collection is the one Pokémon.
        Object.defineProperty(team, 'pokemon', { value: { getItems: () => [pikachu] } });
        owner.pokemon_team = team;

        helix = {
            byToken: helixUser(VIEWER, 'viewer'),
            byLogin: { admin: helixUser(ADMIN, 'admin') },
        };
        const twitch = fakeFetch({
            'https://id.twitch.tv/oauth2/token': init => {
                const form = new URLSearchParams(init?.body as string);
                if (form.get('grant_type') === 'client_credentials')
                    return {
                        body: { access_token: 'app-token', expires_in: 3600, token_type: 'bearer' },
                    };
                if (form.get('code') !== 'abc')
                    return {
                        status: 400,
                        body: { status: 400, message: 'Invalid authorization code' },
                    };
                return {
                    body: {
                        access_token: 'user-token',
                        refresh_token: 'user-refresh',
                        expires_in: 14_000,
                        scope: ['chat:read'],
                        token_type: 'bearer',
                    },
                };
            },
        });
        vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(
                typeof input === 'string'
                    ? input
                    : input instanceof URL
                    ? input.toString()
                    : input.url,
            );
            if (url.origin + url.pathname !== 'https://api.twitch.tv/helix/users')
                return twitch.fn(input, init);
            const login = url.searchParams.get('login');
            if (login !== null)
                return Response.json({
                    data: login in helix.byLogin ? [helix.byLogin[login]] : [],
                });
            if (helix.byToken === null) return new Response('down', { status: 500 });
            return Response.json({ data: [helix.byToken] });
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // ── parity ──────────────────────────────────────────────────────────────

    describe('parity (served-routes/v1, the shared checker)', () => {
        it('the document is relative to the global prefix brobot serves under', () => {
            expect(brobotServers.map(server => server.url)).toEqual([`/${GLOBAL_PREFIX}`]);
        });

        it('reads a served-routes/v1 file the shared schema and checker accept', () => {
            expect(checker.validateServedRoutes(served)).toEqual([]);
            const schemaAjv = new Ajv2020({ strict: true, allErrors: true });
            const validate = schemaAjv.compile(
                JSON.parse(readFileSync(SERVED_ROUTES_SCHEMA, 'utf8')) as object,
            );
            expect(validate(served), schemaAjv.errorsText(validate.errors)).toBe(true);
            expect(served.routes).toHaveLength(24);
        });

        it(`${SERVED_ROUTES_FILE} is what Nest serves — run \`${SERVED_ROUTES_COMMAND}\` in apps/brobot and commit the result`, () => {
            const rendered = renderServedRoutes(served);
            if (process.env[SERVED_ROUTES_WRITE_ENV] === '1') {
                writeFileSync(SERVED_ROUTES_PATH, rendered);
            }
            const committed = existsSync(SERVED_ROUTES_PATH)
                ? readFileSync(SERVED_ROUTES_PATH, 'utf8')
                : '';
            expect(
                committed,
                `${SERVED_ROUTES_FILE} is stale: run \`${SERVED_ROUTES_COMMAND}\` in apps/brobot and commit the result`,
            ).toBe(rendered);
            expect(checker.validateServedRoutes(JSON.parse(committed))).toEqual([]);
        });

        it('reads query and path names from the ZodValidationPipe, never the raw query', () => {
            const route = (source: string) => served.routes.find(r => r.source === source);
            expect(route('PokemonController.team')).toMatchObject({
                query: ['login'],
                responses: ['200', '400', '404', '429', '502'],
            });
            expect(route('AuthController.callback')?.query).toEqual(['code', 'error', 'state']);
            expect(route('TransferController.listByPath')).toMatchObject({
                path: '/internal/transfer/users/{twitchId}/pokemon',
                pathParams: ['twitchId'],
                headers: ['authorization'],
            });
            expect(served.routes.filter(r => r.query === null)).toEqual([]);
        });

        it('reports 0 errors against the committed openapi.json', () => {
            const findings = checker.checkServedRoutes(served, document);
            const errors = findings.filter(finding => finding.severity === 'error');
            expect(errors.map(f => `${f.where}: ${f.message}`)).toEqual([]);
            expect(findings).toEqual([]);
        });

        it.each(OUTSIDE_THE_DOCUMENT)(
            '$path ($kind) is outside the document on purpose',
            ({ path, kind }) => {
                const relative = path.startsWith(`/${GLOBAL_PREFIX}/`)
                    ? path.slice(GLOBAL_PREFIX.length + 1)
                    : null;
                if (kind === 'eventsub') {
                    // Outside the server URL, so no operation of the document could name it.
                    expect(relative).toBeNull();
                } else {
                    expect(Object.keys(document.paths)).not.toContain(relative);
                    expect(served.routes.map(r => r.path)).not.toContain(relative);
                }
            },
        );

        it('pins every WebSocket gateway the app registers, and nothing else', () => {
            const gateways = appGatewayPaths(app);
            expect(gateways).toEqual(
                OUTSIDE_THE_DOCUMENT.filter(pin => pin.kind === 'websocket')
                    .map(pin => pin.path)
                    .sort(),
            );
        });
    });

    // ── response conformance ────────────────────────────────────────────────

    interface Exchange {
        params?: Record<string, string>;
        query?: Record<string, string>;
        body?: unknown;
        headers?: Record<string, string>;
        cookies?: Record<string, string>;
    }

    /**
     * Calls `operationId` at the document's own path and holds the answer to
     * it: the status is declared and listed in the served routes, a declared
     * body validates against the document's schema for that status, an
     * undeclared one is not JSON, and every required header is sent and valid.
     */
    async function exchange(operationId: string, init: Exchange = {}): Promise<request.Response> {
        const entry = operations.get(operationId);
        if (!entry) throw new Error(`${operationId} is not in openapi.json`);
        const { path, method, operation } = entry;
        const url = `/${GLOBAL_PREFIX}${path.replace(/\{(\w+)\}/g, (_, name: string) => {
            const value = init.params?.[name];
            if (value === undefined) throw new Error(`${operationId}: no value for {${name}}`);
            return encodeURIComponent(value);
        })}`;

        const agent = request(app.getHttpServer());
        let call = method === 'post' ? agent.post(url) : agent.get(url);
        if (init.query) call = call.query(init.query);
        for (const [name, value] of Object.entries(init.headers ?? {}))
            call = call.set(name, value);
        if (init.cookies) {
            call = call.set(
                'Cookie',
                Object.entries(init.cookies)
                    .map(([name, value]) => `${name}=${value}`)
                    .join('; '),
            );
        }
        const res = await (init.body === undefined ? call : call.send(init.body as object));

        const status = String(res.status);
        const key = [status, `${status[0]}XX`, 'default'].find(k => k in operation.responses);
        expect(
            key,
            `${operationId} answered ${status}, which openapi.json does not declare`,
        ).toBeDefined();
        const source = served.routes.find(
            r => r.method === method.toUpperCase() && r.path === path,
        );
        expect(
            source?.responses,
            `${operationId} answered ${status}: list it in the served routes (HANDLERS)`,
        ).toContain(status);

        const declared = operation.responses[key as string];
        const at = `/paths/${token(path)}/${method}/responses/${key as string}`;
        const json = declared.content?.['application/json'];
        if (json) {
            expect(res.headers['content-type'], `${operationId} ${status}`).toMatch(
                /^application\/json/,
            );
            const validate = validator(`${at}/content/application~1json/schema`);
            expect(
                validate(res.body),
                `${operationId} ${status}: ${ajv.errorsText(validate.errors)}`,
            ).toBe(true);
        } else {
            expect(
                declared.content,
                `${operationId} ${status} declares only JSON or nothing`,
            ).toBeUndefined();
            expect(
                res.headers['content-type'] ?? '',
                `${operationId} ${status} declares no body`,
            ).not.toMatch(/json/);
        }
        for (const [name, header] of Object.entries(declared.headers ?? {})) {
            const value = res.headers[name.toLowerCase()] as string | undefined;
            if (header.required)
                expect(value, `${operationId} ${status}: header ${name}`).toBeDefined();
            if (value !== undefined && header.schema) {
                const validate = validator(`${at}/headers/${token(name)}/schema`);
                expect(
                    validate(value),
                    `${operationId} ${status} header ${name}: ${ajv.errorsText(validate.errors)}`,
                ).toBe(true);
            }
        }

        const statuses = answered.get(operationId) ?? new Set<number>();
        statuses.add(res.status);
        answered.set(operationId, statuses);
        return res;
    }

    const sessionOf = async (oauthId: string) => {
        const user = await em.findOne(TwitchUser, { oauth_id: oauthId });
        return app.get(TokenService).generateTokenPair(user as TwitchUser);
    };
    const bearer = async (oauthId: string) => ({
        Authorization: `Bearer ${(await sessionOf(oauthId)).accessToken}`,
    });
    const json = { Accept: 'application/json' };
    const callbackCookie = (flow: 'viewer' | 'streamer' | 'bot') => ({
        [stateCookieName(flow)]: 'state-1',
    });
    const signedCallback = { code: 'abc', state: 'state-1' };

    describe('response conformance (Ajv 2020 against openapi.json)', () => {
        it('health', async () => {
            expect((await exchange('getHealth')).status).toBe(200);
            expect((await exchange('getLiveness')).status).toBe(200);
        });

        it('the start routes redirect to Twitch', async () => {
            for (const id of ['twitchLogin', 'twitchStreamerLink', 'twitchBotLink']) {
                expect((await exchange(id)).status).toBe(302);
            }
        });

        it('the viewer callback: the pair, a redirect, and each refusal', async () => {
            expect(
                (
                    await exchange('twitchCallback', {
                        query: signedCallback,
                        cookies: callbackCookie('viewer'),
                        headers: json,
                    })
                ).status,
            ).toBe(200);
            expect(
                (
                    await exchange('twitchCallback', {
                        query: signedCallback,
                        cookies: callbackCookie('viewer'),
                    })
                ).status,
            ).toBe(302);
            expect(
                (await exchange('twitchCallback', { query: signedCallback, headers: json })).status,
            ).toBe(401);
            expect(
                (await exchange('twitchCallback', { query: { code: '' }, headers: json })).status,
            ).toBe(400);
            helix.byToken = null;
            expect(
                (
                    await exchange('twitchCallback', {
                        query: signedCallback,
                        cookies: callbackCookie('viewer'),
                        headers: json,
                    })
                ).status,
            ).toBe(502);
        });

        it('the streamer and bot callbacks: linked, or the wrong account', async () => {
            helix.byToken = helixUser(RAW_TEST_ENV.TWITCH_STREAMER_OAUTH_ID, 'streamer');
            expect(
                (
                    await exchange('twitchStreamerCallback', {
                        query: signedCallback,
                        cookies: callbackCookie('streamer'),
                        headers: json,
                    })
                ).status,
            ).toBe(200);
            helix.byToken = helixUser(VIEWER, 'viewer');
            expect(
                (
                    await exchange('twitchStreamerCallback', {
                        query: signedCallback,
                        cookies: callbackCookie('streamer'),
                        headers: json,
                    })
                ).status,
            ).toBe(403);
            expect(
                (
                    await exchange('twitchBotCallback', {
                        query: signedCallback,
                        cookies: callbackCookie('bot'),
                        headers: json,
                    })
                ).status,
            ).toBe(403);
            helix.byToken = helixUser(RAW_TEST_ENV.TWITCH_BOT_OAUTH_ID, 'bot');
            expect(
                (
                    await exchange('twitchBotCallback', {
                        query: signedCallback,
                        cookies: callbackCookie('bot'),
                        headers: json,
                    })
                ).status,
            ).toBe(200);
            expect(
                (
                    await exchange('twitchBotCallback', {
                        query: signedCallback,
                        cookies: callbackCookie('bot'),
                    })
                ).status,
            ).toBe(302);
        });

        it('the session: status, both refreshes in bearer mode, and logout', async () => {
            expect(
                (await exchange('getAuthStatus', { headers: await bearer(VIEWER) })).status,
            ).toBe(200);
            expect((await exchange('getAuthStatus')).status).toBe(401);
            for (const id of ['refreshTwitchSession', 'refreshSession']) {
                const { refreshToken } = await sessionOf(VIEWER);
                expect((await exchange(id, { body: { refreshToken } })).status).toBe(200);
                expect((await exchange(id, { body: { refreshToken: '' } })).status).toBe(400);
                expect((await exchange(id, { body: { refreshToken: 'not-a-jwt' } })).status).toBe(
                    401,
                );
                expect((await exchange(id, { body: {} })).status).toBe(401);
            }
            expect((await exchange('logout')).status).toBe(204);
        });

        it('commands', async () => {
            expect((await exchange('listCommands')).status).toBe(200);
            const admin = await bearer(ADMIN);
            expect(
                (
                    await exchange('setCommandEnabled', {
                        body: { name: 'quack', enabled: false },
                        headers: admin,
                    })
                ).status,
            ).toBe(201);
            expect(
                (
                    await exchange('setCommandEnabled', {
                        body: { name: 'no-such-command', enabled: false },
                        headers: admin,
                    })
                ).status,
            ).toBe(404);
            expect(
                (await exchange('setCommandEnabled', { body: { name: 'quack' }, headers: admin }))
                    .status,
            ).toBe(400);
            expect(
                (
                    await exchange('setCommandEnabled', {
                        body: { name: 'quack', enabled: true },
                        headers: await bearer(VIEWER),
                    })
                ).status,
            ).toBe(403);
            expect(
                (await exchange('setCommandEnabled', { body: { name: 'quack', enabled: true } }))
                    .status,
            ).toBe(401);
        });

        it('the Pokémon pages', async () => {
            expect((await exchange('getLeaderboard')).status).toBe(200);
            expect((await exchange('getBattleOutcome')).status).toBe(200);
            expect((await exchange('getTeamBattleOutcome')).status).toBe(200);
        });

        it('the team lookup: a team, no such login, Twitch down, a bad login, and the throttle', async () => {
            expect((await exchange('getTeam', { query: { login: 'admin' } })).status).toBe(200);
            expect((await exchange('getTeam', { query: { login: 'nobody' } })).status).toBe(404);
            vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
            expect((await exchange('getTeam', { query: { login: 'unseen' } })).status).toBe(502);
            expect((await exchange('getTeam', { query: { login: '../x' } })).status).toBe(400);
            // 10 per client per minute; four are spent above.
            let status = 0;
            for (let i = 0; i < 7 && status !== 429; i++)
                status = (await exchange('getTeam', { query: { login: '../x' } })).status;
            expect(status).toBe(429);
        });

        it('the transfer side door', async () => {
            const auth = { Authorization: SERVICE };
            expect(
                (
                    await exchange('listUserTransferPokemon', {
                        params: { twitchId: ADMIN },
                        headers: auth,
                    })
                ).status,
            ).toBe(200);
            expect(
                (
                    await exchange('listUserTransferPokemon', {
                        params: { twitchId: 'abc' },
                        headers: auth,
                    })
                ).status,
            ).toBe(400);
            expect(
                (await exchange('listUserTransferPokemon', { params: { twitchId: ADMIN } })).status,
            ).toBe(401);
            expect(
                (
                    await exchange('listTransferPokemon', {
                        query: { twitchId: ADMIN },
                        headers: auth,
                    })
                ).status,
            ).toBe(200);
            expect((await exchange('listTransferPokemon', { headers: auth })).status).toBe(400);

            const depart = { twitchId: ADMIN, pmdRegisterId: REGISTER, nonce: 'n1' };
            expect(
                (
                    await exchange('departPokemon', {
                        params: { id: pikachu.id },
                        body: { ...depart, twitchId: VIEWER },
                        headers: auth,
                    })
                ).status,
            ).toBe(403);
            expect(
                (
                    await exchange('departPokemon', {
                        params: { id: pikachu.id },
                        body: depart,
                        headers: auth,
                    })
                ).status,
            ).toBe(200);
            expect(
                (
                    await exchange('departPokemon', {
                        params: { id: REGISTER },
                        body: depart,
                        headers: auth,
                    })
                ).status,
            ).toBe(404);
            expect(
                (
                    await exchange('departPokemon', {
                        params: { id: pikachu.id },
                        body: {},
                        headers: auth,
                    })
                ).status,
            ).toBe(400);

            const giveBack = { twitchId: ADMIN, pmdRegisterId: REGISTER, level: 55, nonce: 'n2' };
            expect(
                (
                    await exchange('returnPokemon', {
                        params: { id: pikachu.id },
                        body: giveBack,
                        headers: auth,
                    })
                ).status,
            ).toBe(200);
            expect(
                (
                    await exchange('returnPokemon', {
                        params: { id: pikachu.id },
                        body: { twitchId: ADMIN, pmdLevel: 100, nonce: 'n3' },
                        headers: auth,
                    })
                ).status,
            ).toBe(409);
            expect(
                (await exchange('returnPokemon', { params: { id: pikachu.id }, body: giveBack }))
                    .status,
            ).toBe(401);
        });

        it('the horror gate', async () => {
            const auth = { Authorization: SERVICE };
            expect((await exchange('getHorrorMode', { headers: auth })).status).toBe(200);
            expect((await exchange('getHorrorMode')).status).toBe(401);
            expect(
                (await exchange('setHorrorMode', { body: { mode: 'rehearsal' }, headers: auth }))
                    .status,
            ).toBe(200);
            expect(
                (await exchange('setHorrorMode', { body: { mode: 'nope' }, headers: auth })).status,
            ).toBe(400);
            expect(
                (await exchange('setHorrorMode', { body: { mode: 'off' }, headers: auth })).status,
            ).toBe(200);
        });

        it('called every operation in the document at least once', () => {
            expect([...operations.keys()].filter(id => !answered.has(id))).toEqual([]);
            expect(answered.size).toBe(24);
        });
    });
});

/** The path of every `@WebSocketGateway` the app registered. */
function appGatewayPaths(app: NestExpressApplication): string[] {
    const found: string[] = [];
    for (const module of app.get(ModulesContainer).values()) {
        for (const wrapper of module.providers.values()) {
            const options = wrapper.metatype
                ? (Reflect.getMetadata(GATEWAY_OPTIONS, wrapper.metatype) as
                      | { path?: string }
                      | undefined)
                : undefined;
            if (options) found.push(options.path ?? '/');
        }
    }
    return found.sort();
}
