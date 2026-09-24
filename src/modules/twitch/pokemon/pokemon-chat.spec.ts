import type { EntityManager } from '@mikro-orm/postgresql';
import { fakeChat, MemoryPokemonStore, memoryRegistry, ScriptedRandom, storedPokemon, viewer } from '../../../../test/bot-fakes';
import { testEnvService } from '../../../../test/helpers';
import type { TwitchOAuthClient } from '../../auth/twitch-oauth.client';
import type { BattleResult, BattleSide } from '../../pokemon/battle/battle-simulator';
import { BattleRunner } from '../../pokemon/battle/battle-simulator';
import type { NewPokemon, PokemonFactory } from '../../pokemon/pokemon-factory';
import type { PokemonWriteService } from '../../pokemon/pokemon-write.service';
import { UiLinks } from '../ui-links';
import { CHALLENGE_TTL_MS, PokemonBattlesService } from './pokemon-battles.service';
import { DAILY_DELETE_LIMIT, PokemonCommandsService } from './pokemon-commands.service';
import { MAX_CATCH_ATTEMPTS, PokemonDropsService } from './pokemon-drops.service';

/** Showdown stand-in: the named side wins; records who fought with what. */
class ScriptedRunner extends BattleRunner {
    fights: [BattleSide, BattleSide][] = [];
    winner: 'p1' | 'p2' | 'tie' = 'p1';

    async run(p1: BattleSide, p2: BattleSide): Promise<BattleResult> {
        this.fights.push([p1, p2]);
        const outcome = this.winner === 'tie' ? { kind: 'tie' as const } : { kind: 'win' as const, winner: this.winner };
        return { outcome, log: ['|turn|1', `|win|${this.winner === 'p2' ? p2.name : p1.name}`], turns: 3, finishingMove: 'Tackle' };
    }
}

const WILD: NewPokemon = {
    name: 'Eevee',
    name_id: 'eevee',
    level: 1,
    shiny: false,
    gender: 'F',
    moves: ['tackle'],
    color: 'Brown',
    dex_num: 133,
    types: ['Normal'],
    nature: 'Calm',
    ability: 'Run Away',
};

function setup(rolls: number[] = []) {
    const { chat, said } = fakeChat();
    const store = new MemoryPokemonStore();
    const runner = new ScriptedRunner();
    const random = new ScriptedRandom(rolls);
    const links = new UiLinks(testEnvService());
    const registry = memoryRegistry();
    const factory = { specific: async (name: string, level: number, shiny: boolean) => ({ ...WILD, name, level, shiny }) };
    const pokemon = store as unknown as PokemonWriteService;
    const battles = new PokemonBattlesService(chat, pokemon, runner, random, links);
    const drops = new PokemonDropsService(testEnvService(), chat, factory as unknown as PokemonFactory, pokemon, random);
    const twitch = { getUserByLogin: async (login: string) => ({ id: `id-${login}`, login, display_name: login }) };
    const roles = new Map<string, string[]>();
    const em = { fork: () => em, findOne: async (_: unknown, where: { oauth_id: string }) => ({ roles: roles.get(where.oauth_id) ?? [] }) };
    const commands = new PokemonCommandsService(
        chat,
        registry,
        pokemon,
        factory as unknown as PokemonFactory,
        battles,
        drops,
        random,
        links,
        twitch as unknown as TwitchOAuthClient,
        em as unknown as EntityManager,
    );
    const type = async (login: string, text: string, extra = {}) => {
        const parsed = text.trim().slice(1).split(/\s+/);
        await commands.handle({
            user: viewer(login, extra),
            text,
            command: { trigger: parsed[0].toLowerCase(), args: parsed.slice(1) },
        });
    };
    return { chat, said, store, runner, registry, battles, drops, commands, roles, type };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('!pokemon team', () => {
    it('links the team page and lists the team, showing a Pokémon away in PMD as such', async () => {
        const { store, said, type } = setup();
        store.give(
            'id-ash',
            storedPokemon('id-ash', 2, 'Eevee', { level: 40, active_game: 'pmd' }),
            storedPokemon('id-ash', 1, 'Pikachu', { level: 12, shiny: true }),
        );
        await type('ash', '!pokemon team');
        expect(said).toEqual([
            'Check out your team here: https://brobot.test/pokemon/team?username=ash · 1. Lv 12 shiny Pikachu · 2. Lv 40 Eevee (away in PMD)',
        ]);
    });

    it('keeps the old replies for no team and an empty one', async () => {
        const { store, said, type } = setup();
        await type('ash', '!pokemon team');
        store.teams.set('id-ash', []);
        await type('ash', '!pokemon team');
        expect(said).toEqual(['You have no pokemon team', 'You have no pokemon in your team']);
    });
});

describe('!pokemon delete / swap', () => {
    it('refuses to delete a Pokémon away in PMD, and does not count it against the daily limit', async () => {
        const { store, said, type } = setup();
        store.give('id-ash', storedPokemon('id-ash', 1, 'Pikachu'), storedPokemon('id-ash', 2, 'Eevee', { active_game: 'pmd' }));
        await type('ash', '!pokemon delete 2');
        expect(said).toEqual(["@ash, your Eevee in slot 2 is away in PMD and can't be deleted"]);
        expect((await store.team('id-ash'))?.map(pokemon => pokemon.name)).toEqual(['Pikachu', 'Eevee']);
    });

    it('deletes one at home with a slaughter line, up to six a day', async () => {
        const { store, said, type } = setup();
        for (let slot = 1; slot <= 6; slot++) store.give('id-ash', storedPokemon('id-ash', slot, `P${slot}`));
        store.give('id-ash', storedPokemon('id-ash', 1, 'Spare'));
        await type('ash', '!pokemon delete 1');
        expect(said[0]).toMatch(/^@ash tiptoed behind P1 and karate chopped their nose off$/);
        for (let slot = 2; slot <= DAILY_DELETE_LIMIT; slot++) await type('ash', `!pokemon remove ${slot}`);
        await type('ash', '!pokemon delete 1');
        expect(said.at(-1)).toBe("@ash, you've exceeded your limit for the day. Try again after 12AM EST");
    });

    it('validates the slot', async () => {
        const { said, type } = setup();
        await type('ash', '!pokemon delete 9');
        await type('ash', '!pokemon swap 1');
        expect(said).toEqual([
            '@ash, please enter a slot number between 1 and 6',
            '@ash, make sure both slot numbers are between 1 and 6',
        ]);
    });

    it('refuses to swap a Pokémon away in PMD', async () => {
        const { store, said, type } = setup();
        store.give('id-ash', storedPokemon('id-ash', 1, 'Pikachu', { active_game: 'pmd' }), storedPokemon('id-ash', 2, 'Onix'));
        await type('ash', '!pokemon swap 1 2');
        expect(said).toEqual(["@ash, your Pikachu in slot 1 is away in PMD and can't be swapped"]);
    });

    it('swaps two at home, keeping their identities', async () => {
        const { store, said, type } = setup();
        const pikachu = storedPokemon('id-ash', 1, 'Pikachu');
        const onix = storedPokemon('id-ash', 2, 'Onix');
        store.give('id-ash', pikachu, onix);
        await type('ash', '!pokemon switch 2 1');
        expect(said).toEqual(['@ash, swap successful']);
        expect([pikachu.slot, onix.slot]).toEqual([2, 1]);
    });

    it('passes the old rule copy through', async () => {
        const { store, said, type } = setup();
        await type('ash', '!pokemon swap 1 2');
        store.give('id-ash', storedPokemon('id-ash', 1, 'Pikachu'));
        await type('ash', '!pokemon swap 1 1');
        await type('ash', '!pokemon swap 1 2');
        expect(said).toEqual(['No team found', "Can't swap to same slot", 'One of your slots has no pokemon']);
    });
});

describe('!pokemon battle', () => {
    function withStarters(ctx: ReturnType<typeof setup>) {
        const pikachu = storedPokemon('id-ash', 1, 'Pikachu', { level: 12 });
        const eevee = storedPokemon('id-gary', 1, 'Eevee', { level: 10 });
        ctx.store.give('id-ash', pikachu);
        ctx.store.give('id-gary', eevee);
        return { pikachu, eevee };
    }

    it('challenges, accepts, fights, and records the result', async () => {
        const ctx = setup();
        const { pikachu, eevee } = withStarters(ctx);
        await ctx.type('ash', '!pokemon battle');
        expect(ctx.said[0]).toBe(
            `@ash's Level 12 Pikachu wants to battle! You have 1 minute to accept their challenge using the command "!pokemon battle"`,
        );
        await ctx.type('gary', '!pokemon battle');

        expect(ctx.runner.fights).toHaveLength(1);
        expect(ctx.runner.fights[0].map(side => [side.name, side.team.map(p => p.name)])).toEqual([
            ['ash', ['Pikachu']],
            ['gary', ['Eevee']],
        ]);
        expect(ctx.store.outcomes.single).toEqual(['|turn|1', '|win|ash']);
        expect([pikachu.wins, pikachu.level, eevee.losses]).toEqual([1, 13, 1]);
        expect(ctx.said.slice(1)).toEqual([
            "On turn 3, ash's Level 12 Pikachu used Tackle and completely obliterated gary's Level 10 Eevee! Details: https://brobot.test/pokemon/battleoutcome",
            "@ash's Pikachu leveled up to 13!",
        ]);

        // The lobby is free again.
        await ctx.type('gary', '!pokemon battle');
        expect(ctx.said.at(-1)).toMatch(/^@gary's Level 10 Eevee wants to battle!/);
    });

    it('will not let a starter away in PMD challenge', async () => {
        const ctx = setup();
        ctx.store.give('id-ash', storedPokemon('id-ash', 1, 'Pikachu', { active_game: 'pmd' }));
        await ctx.type('ash', '!pokemon battle');
        expect(ctx.said).toEqual(["@ash, your Pikachu in slot 1 is away in PMD and can't battle"]);
        // Nobody is left waiting on a challenge that was refused.
        withStarters(ctx);
        await ctx.type('gary', '!pokemon battle');
        expect(ctx.said.at(-1)).toMatch(/^@gary's Level 10 Eevee wants to battle!/);
    });

    it('will not let a starter away in PMD accept, and leaves the challenge open', async () => {
        const ctx = setup();
        withStarters(ctx);
        ctx.store.give('id-misty', storedPokemon('id-misty', 1, 'Staryu', { active_game: 'pmd' }));
        await ctx.type('ash', '!pokemon battle');
        await ctx.type('misty', '!pokemon battle');
        expect(ctx.said.at(-1)).toBe("@misty, your Staryu in slot 1 is away in PMD and can't battle");
        expect(ctx.runner.fights).toHaveLength(0);

        await ctx.type('gary', '!pokemon battle');
        expect(ctx.runner.fights).toHaveLength(1);
    });

    it('calls the battle off if the challenger\'s starter leaves for PMD before anyone accepts', async () => {
        const ctx = setup();
        const { pikachu } = withStarters(ctx);
        await ctx.type('ash', '!pokemon battle');
        pikachu.active_game = 'pmd';
        await ctx.type('gary', '!pokemon battle');
        expect(ctx.runner.fights).toHaveLength(0);
        expect(ctx.said.at(-1)).toBe("@ash, your Pikachu in slot 1 is away in PMD and can't battle. The battle is off");
    });

    it('keeps the old replies for self-battles and missing starters', async () => {
        const ctx = setup();
        ctx.store.give('id-ash', storedPokemon('id-ash', 1, 'Pikachu'));
        ctx.store.give('id-brock', storedPokemon('id-brock', 2, 'Onix'));
        await ctx.type('nobody', '!pokemon battle');
        await ctx.type('brock', '!pokemon battle');
        await ctx.type('ash', '!pokemon battle');
        await ctx.type('ash', '!pokemon battle');
        await ctx.type('nobody', '!pokemon battle');
        expect(ctx.said).toEqual([
            "@nobody, you don't have any pokemon. You can birth one using channel points",
            "@brock, you don't have a pokemon assigned to slot 1. Swap another pokemon into slot 1 or birth one using channel points",
            expect.stringMatching(/^@ash's Level 5 Pikachu wants to battle!/),
            "You can't battle yourself, @ash",
            "@nobody, you don't have any pokemon. You can birth one using channel points",
        ]);
    });

    it('expires an unanswered challenge after a minute', async () => {
        vi.useFakeTimers();
        const ctx = setup();
        withStarters(ctx);
        await ctx.type('ash', '!pokemon battle');
        vi.advanceTimersByTime(CHALLENGE_TTL_MS);
        expect(ctx.said.at(-1)).toBe("Ending pending pokemon battle for @ash. You're simply built different");
    });
});

describe('!pokemon teambattle', () => {
    it('fields only the Pokémon at home and records every one of them', async () => {
        const ctx = setup();
        const home = storedPokemon('id-ash', 1, 'Pikachu', { level: 10 });
        const away = storedPokemon('id-ash', 2, 'Eevee', { level: 50, active_game: 'pmd' });
        const onix = storedPokemon('id-gary', 1, 'Onix', { level: 20 });
        ctx.store.give('id-ash', home, away);
        ctx.store.give('id-gary', onix);
        ctx.runner.winner = 'p2';

        await ctx.type('ash', '!pokemon teambattle');
        await ctx.type('gary', '!pokemon teambattle');

        expect(ctx.runner.fights[0][0].team.map(p => p.name)).toEqual(['Pikachu']);
        expect([home.losses, away.losses, onix.wins]).toEqual([1, 0, 1]);
        expect(ctx.said.at(-1)).toBe(
            "On turn 3, gary's team(+20) completely obliterated ash's team(+10). Details: https://brobot.test/pokemon/battleoutcome",
        );
        expect(ctx.store.outcomes.team).not.toBeNull();
    });

    it('refuses a team that is entirely away in PMD', async () => {
        const ctx = setup();
        ctx.store.give('id-ash', storedPokemon('id-ash', 1, 'Pikachu', { active_game: 'pmd' }));
        await ctx.type('ash', '!pokemon teambattle');
        expect(ctx.said).toEqual(['@ash, all of your pokemon are away in PMD']);
    });
});

describe('drops and !pokemon catch', () => {
    it('announces a drop, lets a viewer catch it once, and ends it after two minutes', async () => {
        vi.useFakeTimers();
        // Catch rolls: 2 = success.
        const ctx = setup([2, 2]);
        await ctx.drops.startDrop(WILD);
        expect(ctx.said[0]).toBe(
            '/me A wild level 1 Eevee has appeared for 2 minutes! Type "!pokemon catch" for a chance to add it to your team',
        );
        await ctx.type('ash', '!pokemon catch');
        await ctx.type('ash', '!pokemon catch');
        expect(ctx.said.slice(1)).toEqual(['@ash, success!']);
        expect((await ctx.store.team('id-ash'))?.map(p => [p.slot, p.name])).toEqual([[1, 'Eevee']]);

        vi.advanceTimersByTime(2 * 60 * 1000);
        expect(ctx.said.at(-1)).toBe('Ending encounter. 1 person caught Eevee');
        await ctx.type('ash', '!pokemon catch');
        expect(ctx.said.at(-1)).toBe('No pokemon to catch. A pokemon will drop every 30 minutes.');
    });

    it('gives three throws, then gives up', async () => {
        // 1 = the ball misses; then pick() rolls for the flavour line.
        const ctx = setup([1, 0, 1, 0, 1, 0]);
        await ctx.drops.startDrop(WILD);
        for (let i = 0; i <= MAX_CATCH_ATTEMPTS; i++) await ctx.type('ash', '!pokemon catch');
        expect(ctx.said.slice(1)).toEqual([
            '@ash, Eevee will not bow to its new leader. Try again...',
            '@ash, Eevee will not bow to its new leader. Try again...',
            '@ash, Eevee will not bow to its new leader. You are out of attempts',
            '@ash you somehow failed 3 times. Try again on the next encounter',
        ]);
    });

    it('skips a slot held by a Pokémon away in PMD, and refuses a full team', async () => {
        const ctx = setup([2, 2]);
        ctx.store.give('id-ash', storedPokemon('id-ash', 1, 'Pikachu', { active_game: 'pmd' }));
        ctx.store.give('id-full', ...[1, 2, 3, 4, 5, 6].map(slot => storedPokemon('id-full', slot, `P${slot}`)));
        await ctx.drops.startDrop(WILD);
        await ctx.type('ash', '!pokemon catch');
        await ctx.type('full', '!pokemon catch');
        expect((await ctx.store.team('id-ash'))?.map(p => p.slot)).toEqual([1, 2]);
        expect(ctx.said.at(-1)).toBe("@full, can't catch pokemon because no slots available. You need to delete one first.");
    });
});

describe('!pokemon create (admin)', () => {
    it('is ignored for ordinary viewers', async () => {
        const ctx = setup();
        await ctx.type('ash', '!pokemon create gary Mew 50 1');
        expect(ctx.said).toEqual([]);
    });

    it('adds the named Pokémon for the broadcaster or an Admin', async () => {
        const ctx = setup();
        ctx.roles.set('id-mod', ['Viewer', 'Admin']);
        await ctx.type('trama', '!pokemon create Gary Mew 50 1', { isBroadcaster: true });
        await ctx.type('mod', '!pokemon create gary Mewtwo 70 0');
        expect(ctx.said).toEqual([
            'Done! See changes: https://brobot.test/pokemon/team?username=gary',
            'Done! See changes: https://brobot.test/pokemon/team?username=gary',
        ]);
        expect((await ctx.store.team('id-gary'))?.map(p => [p.slot, p.name, p.level, p.shiny])).toEqual([
            [1, 'Mew', 50, true],
            [2, 'Mewtwo', 70, false],
        ]);
    });

    it('explains its usage when arguments are missing', async () => {
        const ctx = setup();
        await ctx.type('trama', '!pokemon create gary', { isBroadcaster: true });
        expect(ctx.said).toEqual(['Usage: !pokemon create <user> <pokemon> <level> <shiny 0|1>']);
    });
});

describe('switches and help', () => {
    it('ignores a switched-off subcommand', async () => {
        const ctx = setup();
        await ctx.registry.setEnabled('pokemon-team', false, 'test');
        await ctx.type('ash', '!pokemon team');
        expect(ctx.said).toEqual([]);
    });

    it('answers bare !pokemon and unknown words with the commands link', async () => {
        const ctx = setup();
        await ctx.type('ash', '!pokemon');
        await ctx.type('ash', '!pokemon seduce');
        expect(ctx.said).toEqual([
            'Pokemon Commands: https://brobot.test/commands',
            'Pokemon Commands: https://brobot.test/commands',
        ]);
    });
});
