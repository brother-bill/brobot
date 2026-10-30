import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../mikro-orm.config';
import { Pokemon, PokemonTeam, TwitchStreamerAuth, TwitchUser } from '.';

/** Constraints the database itself must enforce, checked against real Postgres. */
describe('brobot schema (Postgres)', () => {
    let orm: MikroORM;

    beforeAll(async () => {
        orm = await MikroORM.init({ ...buildOrmConfig(process.env.TEST_DATABASE_URL), logger: () => undefined });
    });

    afterAll(async () => {
        await orm.close(true);
    });

    beforeEach(async () => {
        await orm.schema.clearDatabase();
    });

    function pokemon(user: TwitchUser, team: PokemonTeam, slot: number | null) {
        return {
            name: 'Pikachu',
            name_id: 'pikachu',
            slot,
            shiny: false,
            dex_num: 25,
            color: 'Yellow',
            gender: 'M',
            nature: 'Jolly',
            ability: 'Static',
            twitch_user: user,
            team,
        };
    }

    async function seedUserWithTeam() {
        const em = orm.em.fork();
        const user = em.create(TwitchUser, { oauth_id: '42', display_name: 'Viewer' });
        const team = em.create(PokemonTeam, { twitch_user: user });
        await em.flush();
        return { em, user, team };
    }

    it('defaults roles, active_game and the counters', async () => {
        const { em, user, team } = await seedUserWithTeam();
        em.create(Pokemon, pokemon(user, team, 1));
        await em.flush();

        const rows = await orm.em.fork().getConnection().execute<{ active_game: string; level: number }[]>(
            'select active_game, level from pokemon',
        );
        expect(rows).toEqual([{ active_game: 'brobot', level: 1 }]);
        const [row] = await orm.em.fork().getConnection().execute<{ roles: string[] }[]>(
            'select roles from twitch_user',
        );
        expect(row.roles).toEqual(['Viewer']);
    });

    it.each([0, 7])('refuses slot %i (pokemon_slot_check)', async slot => {
        const { em, user, team } = await seedUserWithTeam();
        em.create(Pokemon, pokemon(user, team, slot));
        await expect(em.flush()).rejects.toThrow(/pokemon_slot_check/);
    });

    it('lets a Pokémon hold no slot (away in PMD), however many of a team do', async () => {
        const { em, user, team } = await seedUserWithTeam();
        em.create(Pokemon, { ...pokemon(user, team, null), active_game: 'pmd' });
        em.create(Pokemon, { ...pokemon(user, team, null), active_game: 'pmd' });
        em.create(Pokemon, pokemon(user, team, 1));
        await em.flush();
        expect(await orm.em.fork().count(Pokemon, { slot: null })).toBe(2);
    });

    it('refuses a second Pokémon in a team slot (pokemon_team_id_slot_unique)', async () => {
        const { em, user, team } = await seedUserWithTeam();
        em.create(Pokemon, pokemon(user, team, 1));
        await em.flush();
        em.create(Pokemon, pokemon(user, team, 1));
        await expect(em.flush()).rejects.toThrow(/pokemon_team_id_slot_unique/);
    });

    it('lets two teams use the same slot', async () => {
        const { em, user, team } = await seedUserWithTeam();
        const other = em.create(TwitchUser, { oauth_id: '43', display_name: 'Other' });
        const otherTeam = em.create(PokemonTeam, { twitch_user: other });
        em.create(Pokemon, pokemon(user, team, 1));
        em.create(Pokemon, pokemon(other, otherTeam, 1));
        await expect(em.flush()).resolves.toBeUndefined();
    });

    it('refuses an active_game other than brobot or pmd', async () => {
        const { user, team } = await seedUserWithTeam();
        const em = orm.em.fork();
        em.create(Pokemon, pokemon(em.getReference(TwitchUser, user.oauth_id), em.getReference(PokemonTeam, team.id), 1));
        await em.flush();
        await expect(
            orm.em.fork().getConnection().execute(`update pokemon set active_game = 'mars'`),
        ).rejects.toThrow();
    });

    it('round-trips a token store row, bigint epoch included, and cascades on user delete', async () => {
        const { em, user } = await seedUserWithTeam();
        em.create(TwitchStreamerAuth, {
            access_token: 'a',
            refresh_token: 'r',
            scope: ['chat:read'],
            expiry_seconds: 3600,
            obtainment_epoch: 1_700_000_000_123,
            twitch_user: user,
        });
        await em.flush();

        const loaded = await orm.em.fork().findOneOrFail(TwitchStreamerAuth, { twitch_user: '42' });
        expect(loaded.obtainment_epoch).toBe(1_700_000_000_123);

        await orm.em.fork().getConnection().execute(`delete from twitch_user where oauth_id = '42'`);
        await expect(orm.em.fork().count(TwitchStreamerAuth)).resolves.toBe(0);
    });
});
