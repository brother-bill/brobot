/**
 * Starts one throwaway Postgres for the integration suite and builds the
 * schema in it: from the migrations once the owner has generated the initial
 * one, from the entity metadata until then. Either way it is this container's
 * schema only — nothing here touches `src/migrations` or a snapshot.
 */
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { MikroORM } from '@mikro-orm/postgresql';
import type { MigrationObject } from '@mikro-orm/core';
import { buildOrmConfig } from '../../src/mikro-orm.config';

// vitest (through vite) rewrites `import.meta.glob` at transform time. brobot
// does not depend on vite directly, so declare just the signature used here.
declare global {
    interface ImportMeta {
        glob<T>(pattern: string, options: { eager: true }): Record<string, T>;
    }
}

let container: StartedPostgreSqlContainer | null = null;

export async function setup(): Promise<void> {
    container = await new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('brobot_test')
        .withUsername('test')
        .withPassword('test')
        .start();
    process.env.TEST_DATABASE_URL = container.getConnectionUri();

    // The migrations are TypeScript. MikroORM would load them with a bare
    // dynamic import, which Node cannot do for .ts ("Unexpected token 'async'"
    // on `override async up()`), so hand it the classes vitest already
    // transformed. The schema is still built by the real migrations.
    const modules = import.meta.glob<Record<string, MigrationObject['class']>>(
        '../../src/migrations/Migration*.ts',
        { eager: true },
    );
    const migrationsList = Object.entries(modules)
        .map(([file, mod]) => {
            const name = file.split('/').pop()!.replace(/\.ts$/, '');
            return { name, class: mod[name] };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    const base = buildOrmConfig(process.env.TEST_DATABASE_URL);
    const orm = await MikroORM.init({
        ...base,
        // snapshot: false — a test must never write .snapshot-*.json into
        // src/migrations; only the migration flow creates those.
        migrations: { ...base.migrations, migrationsList, snapshot: false },
        logger: () => undefined,
    });
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
