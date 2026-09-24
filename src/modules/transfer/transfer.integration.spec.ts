import { MikroORM } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pokemon, TwitchUser } from '../../entities';
import { buildOrmConfig } from '../../mikro-orm.config';
import { TransferLog } from './entities/transfer-log.entity';
import { parseCopyDump } from './import/pg-text';
import { applyImport, countNewTables, planImport } from './import/prisma-import';
import { TransferService } from './transfer.service';

const DUMP = readFileSync(
    join(__dirname, '../../../test/fixtures/prisma-import/old-prisma.data.sql'),
    'utf8',
);
const PIKACHU = '0f6f8a4e-2b1c-4d3e-8f9a-1b2c3d4e5f60';
const REGISTER = '11111111-1111-4111-8111-111111111111';

/** The import and the transfer state machine against real Postgres. */
describe('Prisma import + transfer (Postgres)', () => {
    let orm: MikroORM;
    let em: EntityManager;

    beforeAll(async () => {
        orm = await MikroORM.init({
            ...buildOrmConfig(process.env.TEST_DATABASE_URL),
            logger: () => undefined,
        });
        em = orm.em;
    });

    afterAll(async () => {
        await orm.close(true);
    });

    beforeEach(async () => {
        await orm.schema.clearDatabase();
    });

    async function importFixture() {
        const plan = planImport(parseCopyDump(DUMP).tables, { continueOnFailure: false });
        await applyImport(em, plan);
    }

    it('imports the fixture dump, and a second run changes nothing', async () => {
        await importFixture();
        const first = await countNewTables(em);
        expect(first).toEqual({
            twitch_user: 4,
            twitch_user_registered: 1,
            twitch_bot_auth: 1,
            twitch_streamer_auth: 1,
            pokemon_team: 2,
            pokemon: 5,
            pokemon_battle_outcome: 1,
            pokemon_team_battle_outcome: 1,
        });
        const before = await em.fork().getConnection().execute('select * from pokemon order by id');

        await importFixture();
        expect(await countNewTables(em)).toEqual(first);
        expect(
            await em.fork().getConnection().execute('select * from pokemon order by id'),
        ).toEqual(before);

        const ash = await em.fork().findOneOrFail(TwitchUser, { oauth_id: '42' });
        expect(ash.display_name).toBe('Ash\\Ketchum');
        expect(ash.roles).toEqual(['Viewer']);
        const pikachu = await em.fork().findOneOrFail(Pokemon, { id: PIKACHU });
        expect(pikachu).toMatchObject({ level: 150, active_game: 'brobot', shiny: true });
        expect(pikachu.created_date.toISOString()).toBe('2022-11-30T13:06:40.123Z');
    });

    it('moves an imported Pokémon to PMD and back, logging both, never losing levels', async () => {
        await importFixture();
        const transfer = new TransferService(em);

        expect((await transfer.listForUser('42')).map(p => p.nameId)).toEqual([
            'pikachu',
            'bulbasaur',
            'ditto',
        ]);

        const departed = await transfer.depart(PIKACHU, {
            twitchId: '42',
            pmdRegisterId: REGISTER,
            nonce: 'n1',
        });
        expect(departed).toMatchObject({
            activeGame: 'pmd',
            levelAtDeparture: 150,
            pmdRegisterId: REGISTER,
        });
        expect(
            await transfer.depart(PIKACHU, {
                twitchId: '42',
                pmdRegisterId: REGISTER,
                nonce: 'n1',
            }),
        ).toEqual(departed);

        // Re-importing while it is away leaves the transfer columns alone.
        await importFixture();
        expect((await em.fork().findOneOrFail(Pokemon, { id: PIKACHU })).active_game).toBe('pmd');

        const returned = await transfer.return(PIKACHU, {
            twitchId: '42',
            pmdRegisterId: REGISTER,
            pmdLevel: 100,
            nonce: 'n2',
        });
        expect(returned).toMatchObject({ activeGame: 'brobot', level: 150 });

        const logs = await em
            .fork()
            .find(TransferLog, { pokemon: PIKACHU }, { orderBy: { id: 'asc' } });
        expect(
            logs.map(log => [log.direction, log.nonce, log.level_before, log.level_after]),
        ).toEqual([
            ['depart', 'n1', 150, 150],
            ['return', 'n2', 150, 150],
        ]);
    });

    it('serialises concurrent departs of one Pokémon: one moves, the other replays', async () => {
        await importFixture();
        const transfer = new TransferService(em);
        const body = { twitchId: '42', pmdRegisterId: REGISTER, nonce: 'same' };
        const [a, b] = await Promise.all([
            transfer.depart(PIKACHU, body),
            transfer.depart(PIKACHU, body),
        ]);
        expect(a).toEqual(b);
        expect(await em.fork().count(TransferLog, { pokemon: PIKACHU })).toBe(1);
    });
});
