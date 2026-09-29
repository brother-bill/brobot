import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../mikro-orm.config';
import { PokemonBattleOutcome, PokemonTeamBattleOutcome } from '../../entities';
import { PokemonReadService } from './pokemon-read.service';

/**
 * The last-battles reads against real Postgres. A mocked EntityManager could
 * not catch MikroORM 6 refusing `findOne(Entity, {})`, which 500'd the
 * brobot.live "Last battles" page on its first day (2026-09-29).
 */
describe('PokemonReadService last battles (Postgres)', () => {
    let orm: MikroORM;
    let service: PokemonReadService;

    beforeAll(async () => {
        orm = await MikroORM.init({ ...buildOrmConfig(process.env.TEST_DATABASE_URL), logger: () => undefined });
        service = new PokemonReadService(orm.em);
    });

    afterAll(async () => {
        await orm.close(true);
    });

    beforeEach(async () => {
        await orm.schema.clearDatabase();
    });

    it('answers an empty outcome when no battle has been fought', async () => {
        await expect(service.battleOutcome()).resolves.toEqual({ outcome: [], updatedDate: null });
        await expect(service.teamBattleOutcome()).resolves.toEqual({ outcome: [], updatedDate: null });
    });

    it('returns the most recently updated battle', async () => {
        const em = orm.em.fork();
        em.create(PokemonBattleOutcome, { outcome: ['older'], updated_date: new Date('2026-01-01T00:00:00Z') });
        em.create(PokemonBattleOutcome, { outcome: ['newest'], updated_date: new Date('2026-09-01T00:00:00Z') });
        em.create(PokemonTeamBattleOutcome, { outcome: ['team newest'], updated_date: new Date('2026-09-02T00:00:00Z') });
        em.create(PokemonTeamBattleOutcome, { outcome: ['team older'], updated_date: new Date('2026-02-01T00:00:00Z') });
        await em.flush();

        await expect(service.battleOutcome()).resolves.toEqual({
            outcome: ['newest'],
            updatedDate: '2026-09-01T00:00:00.000Z',
        });
        await expect(service.teamBattleOutcome()).resolves.toEqual({
            outcome: ['team newest'],
            updatedDate: '2026-09-02T00:00:00.000Z',
        });
    });
});
