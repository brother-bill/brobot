import { MikroORM } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pokemon, PokemonTeam, TwitchUser } from '../../entities';
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
/** Ash's team in the fixture: Pikachu in slot 1, Bulbasaur in 2, Ditto in 3. */
const ASH_TEAM = '5b7d1f0e-6a51-4c1f-9d0a-0b8f3c2a4e11';
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
        expect((await em.fork().findOneOrFail(Pokemon, { id: PIKACHU })).slot).toBeNull();
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

    it('stores an evolution and a new moveset brought home, once', async () => {
        await importFixture();
        const transfer = new TransferService(em);
        await transfer.depart(PIKACHU, { twitchId: '42', pmdRegisterId: REGISTER, nonce: 'n1' });

        const body = {
            twitchId: '42',
            pmdRegisterId: REGISTER,
            pmdLevel: 100,
            nonce: 'n2',
            species: { nameId: 'raichu' },
            moves: ['thunder', 'irontail'],
        };
        const returned = await transfer.return(PIKACHU, body);
        expect(await transfer.return(PIKACHU, body)).toEqual(returned);

        const row = await em.fork().findOneOrFail(Pokemon, { id: PIKACHU });
        expect(row).toMatchObject({
            active_game: 'brobot',
            level: 150,
            name: 'Raichu',
            name_id: 'raichu',
            dex_num: 26,
            types: ['Electric'],
            color: 'Yellow',
            moves: ['thunder', 'irontail'],
        });
        expect(await em.fork().count(TransferLog, { pokemon: PIKACHU })).toBe(2);
    });

    describe('slots: an away Pokémon holds none', () => {
        async function slots(): Promise<Record<string, number | null>> {
            const rows = await em.fork().find(Pokemon, { team: ASH_TEAM });
            return Object.fromEntries(rows.map(row => [row.name_id, row.slot]));
        }

        async function catchInto(slot: number, nameId: string) {
            const fork = em.fork();
            const team = await fork.findOneOrFail(PokemonTeam, { id: ASH_TEAM });
            fork.create(Pokemon, {
                name: nameId,
                name_id: nameId,
                slot,
                shiny: false,
                dex_num: 1,
                color: 'Green',
                gender: 'M',
                nature: 'Hardy',
                ability: 'Overgrow',
                team,
                twitch_user: '42',
            });
            await fork.flush();
        }

        const away = { twitchId: '42', pmdRegisterId: REGISTER, nonce: 'd1' };
        const home = { twitchId: '42', pmdRegisterId: REGISTER, pmdLevel: 100, nonce: 'r1' };

        it('frees slot 1 when the starter departs, and takes it back on return when still free', async () => {
            await importFixture();
            const transfer = new TransferService(em);
            await transfer.depart(PIKACHU, away);
            expect(await slots()).toEqual({ pikachu: null, bulbasaur: 2, ditto: 3 });

            await transfer.return(PIKACHU, home);
            expect(await slots()).toEqual({ pikachu: 1, bulbasaur: 2, ditto: 3 });
        });

        it('returns into the lowest free slot once slot 1 has been filled', async () => {
            await importFixture();
            const transfer = new TransferService(em);
            await transfer.depart(PIKACHU, away);
            await catchInto(1, 'eevee');

            await transfer.return(PIKACHU, home);
            expect(await slots()).toEqual({ pikachu: 4, bulbasaur: 2, ditto: 3, eevee: 1 });
        });

        it('refuses a return to a full team with 409 team_full, moving nothing', async () => {
            await importFixture();
            const transfer = new TransferService(em);
            await transfer.depart(PIKACHU, away);
            for (const [slot, nameId] of [[1, 'eevee'], [4, 'onix'], [5, 'mew'], [6, 'abra']] as const) {
                await catchInto(slot, nameId);
            }

            await expect(transfer.return(PIKACHU, home)).rejects.toMatchObject({
                status: 409,
                response: {
                    code: 'team_full',
                    message: 'your brobot team is full: free a slot with !pokemon delete <n> first',
                },
            });
            const row = await em.fork().findOneOrFail(Pokemon, { id: PIKACHU });
            expect([row.active_game, row.slot]).toEqual(['pmd', null]);
            expect(await em.fork().count(TransferLog, { pokemon: PIKACHU, direction: 'return' })).toBe(0);
        });
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
