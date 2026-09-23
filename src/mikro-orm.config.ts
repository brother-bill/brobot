import * as path from 'node:path';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { Options } from '@mikro-orm/postgresql';
import { ENTITIES } from './entities';

/**
 * One ORM configuration for both the Nest app (`app.module.ts`, which passes
 * the validated DATABASE_URL) and the MikroORM CLI (the default export below,
 * which reads it from the environment directly so `migration:create` does not
 * need every Twitch variable set).
 *
 * Migrations run at container start (`main.ts`), under the healthcheck's
 * start_period — never as a separate deploy step that can leave the API down
 * (plan §7: the old deploy ran `prisma migrate deploy` then `pm2 kill`).
 */
export function buildOrmConfig(databaseUrl: string | undefined): Options {
    return defineConfig({
        driver: PostgreSqlDriver,
        clientUrl: databaseUrl,
        entities: ENTITIES,
        extensions: [Migrator],
        strict: true,
        timezone: 'UTC',
        debug: false,
        driverOptions: {
            connection: {
                // Same reasoning as api-time: without keepalive an idle pooled
                // connection is dropped by the network and the next query fails.
                keepAlive: true,
                keepAliveInitialDelayMillis: 10_000,
            },
        },
        migrations: {
            path: path.join(__dirname, 'migrations'),
            pathTs: path.join(__dirname, 'migrations'),
            transactional: true,
            allOrNothing: true,
        },
    });
}

export default buildOrmConfig(process.env.DATABASE_URL);
