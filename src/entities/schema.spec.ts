import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../mikro-orm.config';

/**
 * The DDL the entities describe, generated from metadata alone (no database).
 * This pins the column map B3's import is written against (Prisma §0 → snake
 * case) and the constraints the old schema lacked. It is NOT a migration —
 * the owner generates that with `mikro-orm migration:create`.
 */
describe('entity metadata → DDL', () => {
    let ddl: string;

    beforeAll(async () => {
        const orm = await MikroORM.init({
            ...buildOrmConfig('postgres://unused:unused@127.0.0.1:1/unused'),
            connect: false,
            logger: () => undefined,
        });
        ddl = await orm.schema.getCreateSchemaSQL({ wrap: false });
        await orm.close(true);
    });

    function table(name: string): string {
        const match = new RegExp(`create table "${name}" \\(([^;]*)\\);`).exec(ddl);
        if (!match) throw new Error(`no create table for ${name}:\n${ddl}`);
        return match[1];
    }

    it('creates exactly the eight old tables (no session table)', () => {
        const tables = [...ddl.matchAll(/create table "([a-z_]+)"/g)].map(match => match[1]).sort();
        expect(tables).toEqual([
            'pokemon',
            'pokemon_battle_outcome',
            'pokemon_team',
            'pokemon_team_battle_outcome',
            'twitch_bot_auth',
            'twitch_streamer_auth',
            'twitch_user',
            'twitch_user_registered',
        ]);
    });

    it('keeps the Twitch id as twitch_user primary key, with roles defaulting to Viewer', () => {
        const columns = table('twitch_user');
        expect(columns).toMatch(/"oauth_id" text not null/);
        expect(columns).toMatch(/"roles" text\[\] not null default '\{Viewer\}'/);
        expect(columns).toMatch(/primary key \("oauth_id"\)/);
    });

    it('maps every Prisma pokemon column to snake case, uuid-keyed', () => {
        const columns = table('pokemon');
        for (const column of [
            '"id" uuid not null',
            '"name" text not null',
            '"name_id" text not null',
            '"slot" int not null',
            '"level" int not null default 1',
            '"shiny" boolean not null',
            '"wins" int not null default 0',
            '"item" text not null default \'\'',
            '"moves" text[] not null default \'{}\'',
            '"dex_num" int not null',
            '"types" text[] not null default \'{}\'',
            '"team_id" uuid null',
            '"user_oauth_id" text not null',
            '"created_date" timestamptz not null default now()',
        ]) {
            expect(columns).toContain(column);
        }
    });

    it('adds the four §4 transfer columns', () => {
        const columns = table('pokemon');
        expect(columns).toMatch(/"active_game" text check \("active_game" in \('brobot', 'pmd'\)\) not null default 'brobot'/);
        expect(columns).toContain('"pmd_register_id" uuid null');
        expect(columns).toContain('"pmd_first_transferred_at" timestamptz null');
        expect(columns).toContain('"level_at_departure" int null');
    });

    it('constrains slot to 1..6', () => {
        expect(ddl).toMatch(/constraint pokemon_slot_check check \(slot between 1 and 6\)/);
    });

    it('keys each token store to one user, bigint epoch, cascading on delete', () => {
        for (const name of ['twitch_bot_auth', 'twitch_streamer_auth']) {
            const columns = table(name);
            expect(columns).toContain('"obtainment_epoch" bigint not null');
            expect(columns).toContain('"user_oauth_id" text not null');
            expect(ddl).toContain(`alter table "${name}" add constraint "${name}_user_oauth_id_unique" unique ("user_oauth_id");`);
            expect(ddl).toMatch(
                new RegExp(
                    `alter table "${name}" add constraint "${name}_user_oauth_id_foreign" foreign key \\("user_oauth_id"\\) references "twitch_user" \\("oauth_id"\\) on update cascade on delete cascade;`,
                ),
            );
        }
    });

    it('sets a pokemon team_id NULL when its team is deleted', () => {
        expect(ddl).toMatch(/"pokemon_team_id_foreign" foreign key \("team_id"\) references "pokemon_team" \("id"\) on update cascade on delete set null/);
    });
});
