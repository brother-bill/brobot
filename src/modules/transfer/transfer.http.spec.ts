import { EntityManager } from '@mikro-orm/postgresql';
import { Global, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { EnvService } from '../../config/env.service';
import { Pokemon, TwitchUser } from '../../entities';
import { FakeEntityManager, RAW_TEST_ENV, testEnvService } from '../../../test/helpers';
import { TransferLog } from './entities/transfer-log.entity';
import { TransferModule } from './transfer.module';

const OWNER = '4242';
const STRANGER = '9999';
const REGISTER = '11111111-1111-4111-8111-111111111111';
const OTHER_REGISTER = '22222222-2222-4222-8222-222222222222';
const AUTH = `Bearer ${RAW_TEST_ENV.BROBOT_SERVICE_TOKEN}`;

type Row = Record<string, unknown>;

/**
 * The shared fake plus what the transfer service uses: `transactional`,
 * `find`, `findOne` ordered by id, and a sequence for `transfer_log.id`.
 */
class TransferFakeEntityManager extends FakeEntityManager {
    private sequence = 0;

    async transactional<T>(work: (em: this) => Promise<T>): Promise<T> {
        const result = await work(this);
        await this.flush();
        return result;
    }

    async find<T>(entity: new () => T, where: Row): Promise<T[]> {
        return this.all(entity).filter(row => matchesRow(row as Row, where));
    }

    override async findOne<T>(
        entity: new () => T,
        where: Row,
        options?: { orderBy?: { id?: 'desc' } },
    ): Promise<T | null> {
        const rows = this.all(entity).filter(row => matchesRow(row as Row, where));
        if (options?.orderBy?.id === 'desc')
            rows.sort((a, b) => ((b as Row).id as number) - ((a as Row).id as number));
        return rows[0] ?? null;
    }

    override create<T extends object>(entity: new () => T, data: Partial<T>): T {
        const row = super.create(entity, data);
        if (row instanceof TransferLog) row.id = ++this.sequence;
        return row;
    }
}

function key(value: unknown): unknown {
    if (value && typeof value === 'object') {
        const record = value as Row;
        return record.oauth_id ?? record.id;
    }
    return value;
}

function matchesRow(row: Row, where: Row): boolean {
    return Object.entries(where).every(([field, expected]) => key(row[field]) === key(expected));
}

describe('/api/internal/transfer (HTTP, database faked)', () => {
    let app: INestApplication;
    let em: TransferFakeEntityManager;
    let owner: TwitchUser;
    let pikachu: Pokemon;

    beforeEach(async () => {
        em = new TransferFakeEntityManager();
        owner = em.insert(TwitchUser, { oauth_id: OWNER, display_name: 'Owner' });
        em.insert(TwitchUser, { oauth_id: STRANGER, display_name: 'Stranger' });
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
        });

        @Global()
        @Module({
            providers: [
                { provide: EnvService, useValue: testEnvService() },
                { provide: EntityManager, useValue: em },
            ],
            exports: [EnvService, EntityManager],
        })
        class TestInfraModule {}

        const moduleRef = await Test.createTestingModule({
            imports: [TestInfraModule, TransferModule],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        app.setGlobalPrefix('api');
        await app.init();
    });

    afterEach(async () => {
        await app.close();
    });

    const http = () => request(app.getHttpServer());
    const depart = (body: Row, id = pikachu.id) =>
        http()
            .post(`/api/internal/transfer/pokemon/${id}/depart`)
            .set('Authorization', AUTH)
            .send(body);
    const giveBack = (body: Row, id = pikachu.id) =>
        http()
            .post(`/api/internal/transfer/pokemon/${id}/return`)
            .set('Authorization', AUTH)
            .send(body);
    const logs = () => em.all(TransferLog);

    describe('auth', () => {
        it.each([
            ['GET', '/api/internal/transfer/users/4242/pokemon'],
            ['GET', '/api/internal/transfer/pokemon?twitchId=4242'],
            ['POST', `/api/internal/transfer/pokemon/${REGISTER}/depart`],
            ['POST', `/api/internal/transfer/pokemon/${REGISTER}/return`],
        ])('%s %s needs the service token', async (method, path) => {
            const call = method === 'GET' ? http().get(path) : http().post(path).send({});
            await call.expect(401);
            const wrong = method === 'GET' ? http().get(path) : http().post(path).send({});
            await wrong.set('Authorization', 'Bearer not-the-token').expect(401);
        });
    });

    describe('list', () => {
        const expectedRow = () => ({
            id: pikachu.id,
            nameId: 'pikachu',
            dexNum: 25,
            name: 'Pikachu',
            level: 40,
            shiny: true,
            gender: 'F',
            nature: 'Jolly',
            ability: 'Static',
            item: '',
            moves: ['thunderbolt', 'quickattack'],
            types: ['Electric'],
            wins: 3,
            losses: 1,
            draws: 0,
            activeGame: 'brobot',
            pmdRegisterId: null,
            levelAtDeparture: null,
            createdDate: '2022-12-01T10:00:00.000Z',
        });

        it('answers every field of the contract, by path and by query', async () => {
            const byPath = await http()
                .get(`/api/internal/transfer/users/${OWNER}/pokemon`)
                .set('Authorization', AUTH)
                .expect(200);
            expect(byPath.body).toEqual({ pokemon: [expectedRow()] });
            const byQuery = await http()
                .get(`/api/internal/transfer/pokemon?twitchId=${OWNER}`)
                .set('Authorization', AUTH)
                .expect(200);
            expect(byQuery.body).toEqual(byPath.body);
        });

        it('answers an empty list for a Twitch id brobot has never seen', async () => {
            const res = await http()
                .get('/api/internal/transfer/users/123/pokemon')
                .set('Authorization', AUTH)
                .expect(200);
            expect(res.body).toEqual({ pokemon: [] });
        });

        it('rejects something that is not a Twitch id', async () => {
            await http()
                .get('/api/internal/transfer/pokemon?twitchId=abc')
                .set('Authorization', AUTH)
                .expect(400);
            await http()
                .get('/api/internal/transfer/pokemon')
                .set('Authorization', AUTH)
                .expect(400);
        });
    });

    describe('depart', () => {
        it('flips the row to pmd, records the departure level, and logs the transition', async () => {
            const res = await depart({
                twitchId: OWNER,
                pmdRegisterId: REGISTER,
                nonce: 'n1',
            }).expect(200);
            expect(res.body.pokemon).toMatchObject({
                id: pikachu.id,
                activeGame: 'pmd',
                pmdRegisterId: REGISTER,
                levelAtDeparture: 40,
                level: 40,
            });
            expect(pikachu.pmd_first_transferred_at).toBeInstanceOf(Date);
            expect(logs()).toHaveLength(1);
            expect(logs()[0]).toMatchObject({
                direction: 'depart',
                nonce: 'n1',
                twitch_id: OWNER,
                pmd_register_id: REGISTER,
                level_before: 40,
                level_after: 40,
            });
        });

        it('is idempotent on the nonce: a repeat returns the same body and logs nothing', async () => {
            const first = await depart({
                twitchId: OWNER,
                pmdRegisterId: REGISTER,
                nonce: 'n1',
            }).expect(200);
            const again = await depart({
                twitchId: OWNER,
                pmdRegisterId: REGISTER,
                nonce: 'n1',
            }).expect(200);
            expect(again.body).toEqual(first.body);
            expect(logs()).toHaveLength(1);
        });

        it('answers 409 pokemon_away to a different nonce under another register row', async () => {
            await depart({ twitchId: OWNER, pmdRegisterId: REGISTER, nonce: 'n1' }).expect(200);
            const res = await depart({
                twitchId: OWNER,
                pmdRegisterId: OTHER_REGISTER,
                nonce: 'n2',
            }).expect(409);
            expect(res.body).toMatchObject({ statusCode: 409, code: 'pokemon_away' });
            expect(pikachu.pmd_register_id).toBe(REGISTER);
        });

        it('answers 404 for an unknown Pokémon and 403 for somebody else’s', async () => {
            const missing = await depart(
                { twitchId: OWNER, pmdRegisterId: REGISTER, nonce: 'n1' },
                '33333333-3333-4333-8333-333333333333',
            ).expect(404);
            expect(missing.body.code).toBe('pokemon_not_found');
            const foreign = await depart({
                twitchId: STRANGER,
                pmdRegisterId: REGISTER,
                nonce: 'n1',
            }).expect(403);
            expect(foreign.body.code).toBe('pokemon_not_owned');
            expect(pikachu.active_game).toBe('brobot');
            expect(logs()).toHaveLength(0);
        });

        it('validates the id and body', async () => {
            await depart(
                { twitchId: OWNER, pmdRegisterId: REGISTER, nonce: 'n1' },
                'not-a-uuid',
            ).expect(400);
            await depart({ twitchId: OWNER, pmdRegisterId: 'nope', nonce: 'n1' }).expect(400);
            await depart({ twitchId: OWNER, pmdRegisterId: REGISTER }).expect(400);
        });
    });

    describe('return', () => {
        beforeEach(async () => {
            await depart({ twitchId: OWNER, pmdRegisterId: REGISTER, nonce: 'n1' }).expect(200);
        });

        it('brings it home at max(departure level, PMD level), with the pmd-contracts body', async () => {
            const res = await giveBack({
                twitchId: OWNER,
                pmdRegisterId: REGISTER,
                level: 55,
                nonce: 'n2',
            }).expect(200);
            expect(res.body.pokemon).toMatchObject({
                activeGame: 'brobot',
                level: 55,
                pmdRegisterId: REGISTER,
                levelAtDeparture: 40,
            });
            expect(logs()[1]).toMatchObject({
                direction: 'return',
                nonce: 'n2',
                level_before: 40,
                level_after: 55,
            });
        });

        it('never regresses a level, with the ticket body (pmdLevel, no register id)', async () => {
            const res = await giveBack({ twitchId: OWNER, pmdLevel: 12, nonce: 'n2' }).expect(200);
            expect(res.body.pokemon).toMatchObject({ activeGame: 'brobot', level: 40 });
        });

        it('is idempotent on the nonce', async () => {
            const first = await giveBack({ twitchId: OWNER, pmdLevel: 55, nonce: 'n2' }).expect(
                200,
            );
            const again = await giveBack({ twitchId: OWNER, pmdLevel: 55, nonce: 'n2' }).expect(
                200,
            );
            expect(again.body).toEqual(first.body);
            expect(logs()).toHaveLength(2);
        });

        it('answers a fresh nonce for a Pokémon already home under that register row without moving it', async () => {
            await giveBack({
                twitchId: OWNER,
                pmdRegisterId: REGISTER,
                level: 55,
                nonce: 'n2',
            }).expect(200);
            const res = await giveBack({
                twitchId: OWNER,
                pmdRegisterId: REGISTER,
                level: 90,
                nonce: 'n3',
            }).expect(200);
            expect(res.body.pokemon).toMatchObject({ activeGame: 'brobot', level: 55 });
            expect(logs()).toHaveLength(2);
        });

        it('refuses to return a Pokémon that is home when no register row vouches for it (409 pokemon_not_away)', async () => {
            await giveBack({ twitchId: OWNER, pmdLevel: 55, nonce: 'n2' }).expect(200);
            const res = await giveBack({ twitchId: OWNER, pmdLevel: 100, nonce: 'n3' }).expect(409);
            expect(res.body.code).toBe('pokemon_not_away');
            expect(pikachu.level).toBe(55);
        });

        it('refuses another register row (409 register_mismatch) and a stranger (403)', async () => {
            const mismatch = await giveBack({
                twitchId: OWNER,
                pmdRegisterId: OTHER_REGISTER,
                level: 55,
                nonce: 'n2',
            }).expect(409);
            expect(mismatch.body.code).toBe('register_mismatch');
            await giveBack({ twitchId: STRANGER, pmdLevel: 55, nonce: 'n2' }).expect(403);
            expect(pikachu.active_game).toBe('pmd');
        });

        it('validates the level: required, integer, 1..100, and consistent when both spellings are sent', async () => {
            await giveBack({ twitchId: OWNER, nonce: 'n2' }).expect(400);
            await giveBack({ twitchId: OWNER, pmdLevel: 101, nonce: 'n2' }).expect(400);
            await giveBack({ twitchId: OWNER, pmdLevel: 0, nonce: 'n2' }).expect(400);
            await giveBack({ twitchId: OWNER, pmdLevel: 5.5, nonce: 'n2' }).expect(400);
            await giveBack({ twitchId: OWNER, pmdLevel: 50, level: 51, nonce: 'n2' }).expect(400);
            await giveBack({ twitchId: OWNER, pmdLevel: 50, level: 50, nonce: 'n2' }).expect(200);
        });

        it('makes round trips: a stale depart nonce is refused, a new one leaves again, first-transfer time is kept', async () => {
            const firstTransfer = pikachu.pmd_first_transferred_at;
            await giveBack({ twitchId: OWNER, pmdLevel: 60, nonce: 'n2' }).expect(200);

            const stale = await depart({
                twitchId: OWNER,
                pmdRegisterId: REGISTER,
                nonce: 'n1',
            }).expect(409);
            expect(stale.body.code).toBe('nonce_reused');
            expect(pikachu.active_game).toBe('brobot');

            const again = await depart({
                twitchId: OWNER,
                pmdRegisterId: REGISTER,
                nonce: 'n3',
            }).expect(200);
            expect(again.body.pokemon).toMatchObject({
                activeGame: 'pmd',
                level: 60,
                levelAtDeparture: 60,
            });
            expect(pikachu.pmd_first_transferred_at).toBe(firstTransfer);
            expect(logs().map(log => [log.direction, log.nonce])).toEqual([
                ['depart', 'n1'],
                ['return', 'n2'],
                ['depart', 'n3'],
            ]);
        });

        it('a level-150 Pokémon visits PMD (cap 100) and comes back as 150', async () => {
            await giveBack({ twitchId: OWNER, pmdLevel: 40, nonce: 'n2' }).expect(200);
            pikachu.level = 150;
            await depart({ twitchId: OWNER, pmdRegisterId: REGISTER, nonce: 'n3' }).expect(200);
            const res = await giveBack({
                twitchId: OWNER,
                pmdRegisterId: REGISTER,
                level: 100,
                nonce: 'n4',
            }).expect(200);
            expect(res.body.pokemon).toMatchObject({ activeGame: 'brobot', level: 150 });
        });
    });
});
