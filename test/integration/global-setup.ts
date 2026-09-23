/**
 * Starts one throwaway Postgres for the integration suite and builds the
 * schema in it: from the migrations once the owner has generated the initial
 * one, from the entity metadata until then. Either way it is this container's
 * schema only — nothing here touches `src/migrations` or a snapshot.
 */
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../src/mikro-orm.config';

let container: StartedPostgreSqlContainer | null = null;

export async function setup(): Promise<void> {
    container = await new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('brobot_test')
        .withUsername('test')
        .withPassword('test')
        .start();
    process.env.TEST_DATABASE_URL = container.getConnectionUri();

    const orm = await MikroORM.init({ ...buildOrmConfig(process.env.TEST_DATABASE_URL), logger: () => undefined });
    try {
        const pending = await orm.getMigrator().getPendingMigrations();
        if (pending.length > 0) {
            await orm.getMigrator().up();
        } else {
            await orm.schema.createSchema();
        }
    } finally {
        await orm.close(true);
    }
}

export async function teardown(): Promise<void> {
    await container?.stop();
}
