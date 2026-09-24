import type { ActiveGame } from '../../entities';
import { assertInBrobot, battleReady, describeSlot, isAwayInPmd, PokemonAwayError } from './exclusivity';
import type { GuardedAction } from './exclusivity';
import { planCreateInSlot, planDelete, planSwap, slotForCatch, TeamRuleError } from './team-rules';

interface Row {
    name: string;
    slot: number;
    level: number;
    shiny: boolean;
    active_game: ActiveGame;
}

const mon = (slot: number, name: string, active_game: ActiveGame = 'brobot', level = 10): Row => ({
    name,
    slot,
    level,
    shiny: false,
    active_game,
});

/**
 * Migration plan §4: a Pokémon with active_game = 'pmd' cannot be battled,
 * swapped, deleted or slotted, and `!pokemon team` shows it as "away in PMD".
 */
describe('brobot exclusivity (plan §4)', () => {
    const home = mon(1, 'Pikachu');
    const away = mon(2, 'Eevee', 'pmd');

    it('knows which game holds a Pokémon', () => {
        expect(isAwayInPmd(home)).toBe(false);
        expect(isAwayInPmd(away)).toBe(true);
    });

    it.each<GuardedAction>(['battle', 'swap', 'delete', 'slot', 'level-up', 'roar'])(
        'refuses to %s a Pokémon away in PMD, and allows it at home',
        action => {
            expect(() => assertInBrobot(home, action)).not.toThrow();
            expect(() => assertInBrobot(away, action)).toThrow(PokemonAwayError);
        },
    );

    it('says why, in chat copy', () => {
        expect(() => assertInBrobot(away, 'delete')).toThrow("your Eevee in slot 2 is away in PMD and can't be deleted");
        expect(() => assertInBrobot(away, 'battle')).toThrow("your Eevee in slot 2 is away in PMD and can't battle");
    });

    describe('battles', () => {
        it('fields only the Pokémon at home', () => {
            const team = [mon(1, 'Pikachu'), mon(2, 'Eevee', 'pmd'), mon(3, 'Onix')];
            expect(battleReady(team).map(pokemon => pokemon.name)).toEqual(['Pikachu', 'Onix']);
        });

        it('fields nobody when the whole team is away', () => {
            expect(battleReady([mon(1, 'Pikachu', 'pmd')])).toEqual([]);
        });
    });

    describe('swaps', () => {
        it('refuses when either Pokémon is away', () => {
            const team = [home, away, mon(3, 'Onix')];
            expect(() => planSwap(team, 1, 2)).toThrow(PokemonAwayError);
            expect(() => planSwap(team, 2, 3)).toThrow(PokemonAwayError);
        });

        it('allows two Pokémon at home, even with another away', () => {
            const team = [home, away, mon(3, 'Onix')];
            expect(planSwap(team, 1, 3).map(pokemon => pokemon.name)).toEqual(['Pikachu', 'Onix']);
        });
    });

    describe('deletes', () => {
        it('refuses to delete a Pokémon that is away', () => {
            expect(() => planDelete([home, away], 2)).toThrow(PokemonAwayError);
        });

        it('deletes one at home', () => {
            expect(planDelete([home, away], 1)).toBe(home);
        });
    });

    describe('slots', () => {
        it('refuses to put a new Pokémon into the slot of one that is away', () => {
            expect(() => planCreateInSlot([home, away], 2)).toThrow(PokemonAwayError);
        });

        it('still replaces a Pokémon at home', () => {
            expect(planCreateInSlot([home, away], 1)).toBe(home);
        });

        it('keeps the away Pokémon\'s slot taken when a catch picks a slot', () => {
            expect(slotForCatch([home, away])).toBe(3);
            expect(slotForCatch([mon(1, 'A', 'pmd')])).toBe(2);
        });

        it('counts away Pokémon towards a full team', () => {
            const full = [1, 2, 3, 4, 5, 6].map(slot => mon(slot, `P${slot}`, slot % 2 ? 'pmd' : 'brobot'));
            expect(() => slotForCatch(full)).toThrow(TeamRuleError);
        });
    });

    describe('!pokemon team', () => {
        it('shows a Pokémon that is away as "away in PMD"', () => {
            expect(describeSlot(away)).toBe('2. Lv 10 Eevee (away in PMD)');
            expect(describeSlot(home)).toBe('1. Lv 10 Pikachu');
            expect(describeSlot({ ...mon(3, 'Onix', 'pmd', 150), shiny: true })).toBe('3. Lv 150 shiny Onix (away in PMD)');
        });
    });
});
