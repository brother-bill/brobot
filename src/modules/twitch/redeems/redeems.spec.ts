import { fakeChat, MemoryPokemonStore, memoryRegistry, ScriptedRandom, storedPokemon } from '../../../../test/bot-fakes';
import { testEnvService } from '../../../../test/helpers';
import type { NewPokemon, PokemonFactory } from '../../pokemon/pokemon-factory';
import type { PokemonWriteService } from '../../pokemon/pokemon-write.service';
import { FunCommandsService } from '../fun/fun-commands.service';
import type { OverlayGateway } from '../overlay.gateway';
import type { OverlayEvent } from '../overlay-events';
import type { StreamerGateway } from '../streamer.gateway';
import { UiLinks } from '../ui-links';
import { PokemonRedeemsService } from './pokemon-redeems.service';
import type { Redemption, RedemptionSettler } from './redemption';
import { RedemptionsService } from './redemptions.service';

const FRESH: NewPokemon = {
    name: 'Bulbasaur',
    name_id: 'bulbasaur',
    level: 1,
    shiny: false,
    gender: 'M',
    moves: ['tackle'],
    color: 'Green',
    dex_num: 1,
    types: ['Grass', 'Poison'],
    nature: 'Bold',
    ability: 'Overgrow',
};

function redemption(rewardTitle: string, input = ''): Redemption {
    return { id: 'r1', rewardId: 'reward', rewardTitle, userId: 'id-ash', login: 'ash', displayName: 'Ash', input };
}

function setup(overlayClients = 1) {
    const { chat, said } = fakeChat();
    const store = new MemoryPokemonStore();
    const settled: string[] = [];
    const settler: RedemptionSettler = {
        fulfill: async r => void settled.push(`fulfilled ${r.id}`),
        refund: async r => void settled.push(`refunded ${r.id}`),
    };
    const shown: OverlayEvent[] = [];
    const overlay = {
        clientCount: overlayClients,
        broadcast: (event: OverlayEvent) => shown.push(event),
    } as unknown as OverlayGateway;
    const factory = { randomFromDex: async () => ({ ...FRESH }) } as unknown as PokemonFactory;
    const random = new ScriptedRandom();
    const registry = memoryRegistry();
    const pokemonRedeems = new PokemonRedeemsService(
        chat,
        store as unknown as PokemonWriteService,
        factory,
        random,
        overlay,
        settler,
    );
    const fun = new FunCommandsService(
        testEnvService(),
        chat,
        registry,
        random,
        new UiLinks(testEnvService()),
        overlay,
        { clientCount: 1 } as unknown as StreamerGateway,
        settler,
    );
    const router = new RedemptionsService(pokemonRedeems, fun);
    return { said, store, settled, shown, registry, redeem: (r: Redemption) => router.handle(r) };
}

describe('Pokemon Create', () => {
    it('creates a starter and roars, leaving the redemption in the queue as before', async () => {
        const ctx = setup();
        await ctx.redeem(redemption('Pokemon Create', ' 1 '));
        expect(ctx.said).toEqual(["/me @ash's Level 1 Bulbasaur roared as it tore through the house."]);
        expect((await ctx.store.team('id-ash'))?.map(p => [p.slot, p.name])).toEqual([[1, 'Bulbasaur']]);
        expect(ctx.settled).toEqual([]);
    });

    it('refunds a bad slot, and a non-starter slot before a starter exists', async () => {
        const ctx = setup();
        await ctx.redeem(redemption('Pokemon Create', 'seven'));
        await ctx.redeem(redemption('Pokemon Create', '3'));
        expect(ctx.said).toEqual([
            '@ash, please enter a slot number between 1 and 6. You have been refunded',
            'You must create a starter pokemon in slot 1 first. You have been refunded',
        ]);
        expect(ctx.settled).toEqual(['refunded r1', 'refunded r1']);
    });

    it('will not replace a Pokémon away in PMD (it cannot be slotted), and refunds', async () => {
        const ctx = setup();
        ctx.store.give('id-ash', storedPokemon('id-ash', 1, 'Pikachu', { active_game: 'pmd' }));
        await ctx.redeem(redemption('Pokemon Create', '1'));
        expect(ctx.said).toEqual(["@ash, your Pikachu in slot 1 is away in PMD and can't be replaced. You have been refunded"]);
        expect(ctx.settled).toEqual(['refunded r1']);
        expect((await ctx.store.team('id-ash'))?.map(p => p.name)).toEqual(['Pikachu']);
    });
});

describe('Pokemon Level Up', () => {
    it('levels the starter and keeps the points', async () => {
        const ctx = setup();
        ctx.store.give('id-ash', storedPokemon('id-ash', 1, 'Pikachu', { level: 7 }));
        await ctx.redeem(redemption('Pokemon Level Up'));
        expect(ctx.said).toEqual(["@ash's Pikachu leveled up to 8!"]);
        expect(ctx.settled).toEqual(['fulfilled r1']);
    });

    it('refunds without a starter, or with one away in PMD', async () => {
        const ctx = setup();
        await ctx.redeem(redemption('Pokemon Level Up'));
        const away = storedPokemon('id-ash', 1, 'Pikachu', { level: 7, active_game: 'pmd' });
        ctx.store.give('id-ash', away);
        await ctx.redeem(redemption('Pokemon Level Up'));
        expect(ctx.said).toEqual([
            '@ash, you have no starter pokemon in slot 1. You will be automatically refunded',
            "@ash, your Pikachu in slot 1 is away in PMD and can't level up. You will be automatically refunded",
        ]);
        expect(ctx.settled).toEqual(['refunded r1', 'refunded r1']);
        expect(away.level).toBe(7);
    });
});

describe('Pokemon Roar', () => {
    it('shows the starter on the overlay', async () => {
        const ctx = setup();
        ctx.store.give('id-ash', storedPokemon('id-ash', 1, 'Pikachu', { level: 9, shiny: true }));
        await ctx.redeem(redemption('Pokemon Roar'));
        expect(ctx.shown).toEqual([
            {
                type: 'pokemon_roar',
                login: 'ash',
                pokemon: expect.objectContaining({ name: 'Pikachu', nameId: 'pikachu', level: 9, shiny: true, dexNum: 25 }),
            },
        ]);
        expect(ctx.settled).toEqual([]);
    });

    it('refunds when the starter is away in PMD, missing, or nobody is watching the overlay', async () => {
        const away = setup();
        away.store.give('id-ash', storedPokemon('id-ash', 1, 'Pikachu', { active_game: 'pmd' }));
        await away.redeem(redemption('Pokemon Roar'));
        expect(away.said).toEqual(["@ash, your Pikachu in slot 1 is away in PMD and can't roar. You have been refunded"]);
        expect(away.shown).toEqual([]);

        const missing = setup();
        await missing.redeem(redemption('Pokemon Roar'));
        expect(missing.said).toEqual(['@ash you have no starter pokemon. You have been refunded']);

        const dark = setup(0);
        dark.store.give('id-ash', storedPokemon('id-ash', 1, 'Pikachu'));
        await dark.redeem(redemption('Pokemon Roar'));
        expect(dark.said).toEqual(['Streamer not connected to browser source. You will be refunded']);
        expect([away.settled, missing.settled, dark.settled]).toEqual([['refunded r1'], ['refunded r1'], ['refunded r1']]);
    });
});

describe('Enable Quacks', () => {
    it('switches !quack on (and stores it), then refunds a second redeem', async () => {
        const ctx = setup();
        await ctx.redeem(redemption('Enable Quacks'));
        expect(ctx.registry.isEnabled('quack')).toBe(true);
        await ctx.redeem(redemption('Enable Quacks'));
        expect(ctx.said).toEqual([
            '/me The command "!quack" has been enabled. Go get em',
            '/me @ash, quacks are already enabled. You have been refunded',
        ]);
        expect(ctx.settled).toEqual(['refunded r1']);
    });

    it('refunds when the overlay is not connected', async () => {
        const ctx = setup(0);
        await ctx.redeem(redemption('Enable Quacks'));
        expect(ctx.said).toEqual(["/me trama is not connected to browser source, so quacks won't work. You have been refunded"]);
        expect(ctx.registry.isEnabled('quack')).toBe(false);
    });
});

it('leaves rewards brobot does not handle alone', async () => {
    const ctx = setup();
    await ctx.redeem(redemption('Hydrate'));
    expect([ctx.said, ctx.settled]).toEqual([[], []]);
});
