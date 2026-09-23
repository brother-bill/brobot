import type { Env } from '../src/config/env.schema';
import { parseEnv } from '../src/config/env.schema';
import type { EnvService } from '../src/config/env.service';

/** A complete, valid raw environment. Tests override single keys. */
export const RAW_TEST_ENV: Record<string, string> = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://brobot:brobot@localhost:5432/brobot',
    DOMAIN: 'admin.brobot.test',
    UI_URL: 'https://brobot.test/',
    ALLOWED_ORIGINS: 'https://brobot.test, http://localhost:4200',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'r'.repeat(40),
    BROBOT_SERVICE_TOKEN: 's'.repeat(40),
    TWITCH_CLIENT_ID: 'client-id',
    TWITCH_CLIENT_SECRET: 'client-secret',
    TWITCH_CALLBACK_URL_USER: 'https://admin.brobot.test/api/auth/twitch/callback',
    TWITCH_CALLBACK_URL_STREAMER: 'https://admin.brobot.test/api/auth/twitch/streamer/callback',
    TWITCH_CALLBACK_URL_BOT: 'https://admin.brobot.test/api/auth/twitch/bot/callback',
    TWITCH_STREAMER_OAUTH_ID: '1000',
    TWITCH_BOT_OAUTH_ID: '2000',
    TWITCH_STREAMER_CHANNEL_LISTEN: 'trama',
    TWITCH_BOT_USERNAME: 'bro_____bot',
    EVENT_SUB_SECRET: 'eventsub-secret',
    WS_SECRET: 'w'.repeat(24),
};

export function testEnv(overrides: Record<string, string> = {}): Env {
    return parseEnv({ ...RAW_TEST_ENV, ...overrides });
}

export function testEnvService(overrides: Record<string, string> = {}): EnvService {
    const env = testEnv(overrides);
    return { get: <K extends keyof Env>(key: K) => env[key] } as EnvService;
}

type AnyEntity = Record<string, unknown>;
type EntityCtor = new () => object;

/**
 * Just enough of MikroORM's EntityManager for the services under test:
 * `fork`, `findOne(OrFail)`, `find`, `create`, `assign`, `flush`, keyed by
 * entity class. Relations are compared by primary key, so
 * `{ twitch_user: user }` and `{ twitch_user: '1000' }` both match.
 */
export class FakeEntityManager {
    readonly rows = new Map<EntityCtor, AnyEntity[]>();
    flushes = 0;

    fork(): this {
        return this;
    }

    all<T>(entity: new () => T): T[] {
        return (this.rows.get(entity as EntityCtor) ?? []) as T[];
    }

    insert<T extends object>(entity: new () => T, data: Partial<T>): T {
        const row = Object.assign(new entity(), data);
        this.rows.set(entity as EntityCtor, [...this.all(entity), row] as AnyEntity[]);
        return row;
    }

    create<T extends object>(entity: new () => T, data: Partial<T>): T {
        return this.insert(entity, data);
    }

    assign<T extends object>(row: T, data: Partial<T>): T {
        return Object.assign(row, data);
    }

    async findOne<T>(entity: new () => T, where: AnyEntity): Promise<T | null> {
        return this.all(entity).find(row => matches(row as AnyEntity, where)) ?? null;
    }

    async findOneOrFail<T>(entity: new () => T, where: AnyEntity): Promise<T> {
        const row = await this.findOne(entity, where);
        if (!row) throw new Error(`${entity.name} not found`);
        return row;
    }

    async flush(): Promise<void> {
        this.flushes++;
    }
}

function primaryKey(value: unknown): unknown {
    if (value && typeof value === 'object') {
        const record = value as AnyEntity;
        return record.oauth_id ?? record.id;
    }
    return value;
}

function matches(row: AnyEntity, where: AnyEntity): boolean {
    return Object.entries(where).every(([key, expected]) => primaryKey(row[key]) === primaryKey(expected));
}

/** A `fetch` stand-in answering by URL prefix; records every call. */
export function fakeFetch(routes: Record<string, (init: RequestInit | undefined) => { status?: number; body: unknown }>) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push({ url, init });
        const route = Object.keys(routes).find(prefix => url.startsWith(prefix));
        if (!route) return new Response('not mocked', { status: 599 });
        const { status = 200, body } = routes[route](init);
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    };
    return { fn, calls };
}
