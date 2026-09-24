import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../../mikro-orm.config';

/** transfer_log's DDL from entity metadata alone (no database). Not a migration. */
describe('transfer_log DDL', () => {
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

    it('has a sequence key and every column the ticket names', () => {
        const columns = /create table "transfer_log" \(([^;]*)\);/.exec(ddl)?.[1] ?? '';
        for (const column of [
            '"id" bigserial primary key',
            '"pokemon_id" uuid not null',
            `"direction" text check ("direction" in ('depart', 'return')) not null`,
            '"nonce" text not null',
            '"twitch_id" text not null',
            '"pmd_register_id" uuid null',
            '"level_before" int not null',
            '"level_after" int not null',
            '"at" timestamptz not null default now()',
        ]) {
            expect(columns).toContain(column);
        }
    });

    it('is unique on (pokemon, direction, nonce) and goes with its Pokémon', () => {
        expect(ddl).toContain(
            'alter table "transfer_log" add constraint "transfer_log_pokemon_direction_nonce_unique" unique ("pokemon_id", "direction", "nonce");',
        );
        expect(ddl).toMatch(
            /"transfer_log_pokemon_id_foreign" foreign key \("pokemon_id"\) references "pokemon" \("id"\) on update cascade on delete cascade/,
        );
    });
});
