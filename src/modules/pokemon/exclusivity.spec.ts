import type { ActiveGame } from '../../entities';
import { assertInBrobot, battleReady, describeSlot, describeTeam, isAwayInPmd, PokemonAwayError } from './exclusivity';
import type { GuardedAction } from './exclusivity';
import { planCreateInSlot, planDelete, planSwap, slotForCatch, TeamRuleError } from './team-rules';

interface Row {
    name: string;
    slot: number | null;
    level: number;
    shiny: boolean;
    active_game: ActiveGame;
}

const mon = (slot: number | null, name: string, active_game: ActiveGame = 'brobot', level = 10): Row => ({
    name,
    slot,
    level,
    shiny: false,
    active_game,
});

/**
 * Migration plan §4: a Pokémon with active_game = 'pmd' cannot be battled,
 * swapped, deleted or slotted, and `!pokemon team` shows it as "away in PMD".
 * Since 2026-10-29 an away Pokémon also holds no slot (slot null), so the
 * slot rules cannot reach it at all; the guards stay as defence in depth,
 * exercised here with a row that left before that rule (`slottedAway`).
 */
describe('brobot exclusivity (plan §4)', () => {
    const home = mon(1, 'Pikachu');
    const away = mon(null, 'Eevee', 'pmd');
    const slottedAway = mon(2, 'Eevee', 'pmd');

    it('knows which game holds a Pokémon', () => {
        expect(isAwayInPmd(home)).toBe(false);
        expect(isAwayInPmd(away)).toBe(true);
    });

    it.each<GuardedAction>(['battle', 'swap', 'delete', 'slot', 'level-up', 'roar'])(
        'refuses to %s a Pokémon away in PMD, and allows it at home',
        action => {
            expect(() => assertInBrobot(home, action)).not.toThrow();
            expect(() => assertInBrobot(away, action)).toThrow(PokemonAwayError);
            expect(() => assertInBrobot(slottedAway, action)).toThrow(PokemonAwayError);
        },
    );

    it('says why, in chat copy, naming a slot only when it holds one', () => {
        expect(() => assertInBrobot(away, 'delete')).toThrow("your Eevee is away in PMD and can't be deleted");
        expect(() => assertInBrobot(away, 'battle')).toThrow("your Eevee is away in PMD and can't battle");
        expect(() => assertInBrobot(slottedAway, 'battle')).toThrow("your Eevee in slot 2 is away in PMD and can't battle");
    });

    describe('battles', () => {
        it('fields only the Pokémon at home', () => {
            const team = [mon(1, 'Pikachu'), mon(null, 'Eevee', 'pmd'), mon(3, 'Onix')];
            expect(battleReady(team).map(pokemon => pokemon.name)).toEqual(['Pikachu', 'Onix']);
        });

        it('fields nobody when the whole team is away', () => {
            expect(battleReady([mon(null, 'Pikachu', 'pmd')])).toEqual([]);
        });
    });

    describe('swaps', () => {
        it('cannot reach an away Pokémon: its old slot is simply empty', () => {
            const team = [home, away, mon(3, 'Onix')];
            expect(planSwap(team, 2, 3)).toEqual([null, team[2]]);
        });

        it('refuses when either Pokémon still holds a slot while away', () => {
            const team = [home, slottedAway, mon(3, 'Onix')];
            expect(() => planSwap(team, 1, 2)).toThrow(PokemonAwayError);
            expect(() => planSwap(team, 2, 3)).toThrow(PokemonAwayError);
        });

        it('allows two Pokémon at home, even with another away', () => {
            const team = [home, away, mon(3, 'Onix')];
            expect(planSwap(team, 1, 3).map(pokemon => pokemon?.name)).toEqual(['Pikachu', 'Onix']);
        });
    });

    describe('deletes', () => {
        it('finds nothing to delete where an away Pokémon used to be', () => {
            expect(planDelete([home, away], 2)).toBeNull();
        });

        it('refuses to delete a Pokémon that still holds a slot while away', () => {
            expect(() => planDelete([home, slottedAway], 2)).toThrow(PokemonAwayError);
        });

        it('deletes one at home', () => {
            expect(planDelete([home, away], 1)).toBe(home);
        });
    });

    describe('slots', () => {
        it('creates into the slot an away Pokémon left, replacing nothing', () => {
            expect(planCreateInSlot([home, away], 2)).toBeNull();
        });

        it('refuses to replace a Pokémon that still holds a slot while away', () => {
            expect(() => planCreateInSlot([home, slottedAway], 2)).toThrow(PokemonAwayError);
        });

        it('still replaces a Pokémon at home', () => {
            expect(planCreateInSlot([home, away], 1)).toBe(home);
        });

        it('lets a catch take the slot an away Pokémon left, slot 1 included', () => {
            expect(slotForCatch([home, away])).toBe(2);
            expect(slotForCatch([mon(null, 'Groudon', 'pmd'), mon(2, 'Onix')])).toBe(1);
        });

        it('does not count away Pokémon towards a full team', () => {
            const team = [1, 2, 3, 4, 5].map(slot => mon(slot, `P${slot}`)).concat(mon(null, 'Away', 'pmd'));
            expect(slotForCatch(team)).toBe(6);
            expect(() => slotForCatch([...team, mon(6, 'P6')])).toThrow(TeamRuleError);
        });
    });

    describe('!pokemon team', () => {
        it('shows a Pokémon that is away as "away in PMD", without a slot number', () => {
            expect(describeSlot(mon(null, 'Groudon', 'pmd', 81))).toBe('away in PMD: Lv 81 Groudon');
            expect(describeSlot(home)).toBe('1. Lv 10 Pikachu');
            expect(describeSlot({ ...mon(null, 'Onix', 'pmd', 150), shiny: true })).toBe('away in PMD: Lv 150 shiny Onix');
        });

        it('still marks a row that holds a slot while away', () => {
            expect(describeSlot(slottedAway)).toBe('2. Lv 10 Eevee (away in PMD)');
        });

        it('lists the slotted team first, by slot, then the Pokémon away in PMD', () => {
            const team = [mon(null, 'Groudon', 'pmd', 81), mon(3, 'Onix'), mon(null, 'Eevee', 'pmd'), mon(2, 'Pikachu')];
            expect(describeTeam(team)).toEqual([
                '2. Lv 10 Pikachu',
                '3. Lv 10 Onix',
                'away in PMD: Lv 81 Groudon',
                'away in PMD: Lv 10 Eevee',
            ]);
        });
    });
});
