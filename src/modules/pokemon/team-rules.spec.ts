import type { ActiveGame } from '../../entities';
import { parseSlot, planCreateInSlot, planDelete, planSwap, slotForCatch, TeamRuleError } from './team-rules';

const mon = (slot: number, name = `P${slot}`, active_game: ActiveGame = 'brobot') => ({ name, slot, active_game });

describe('team rules', () => {
    describe('parseSlot', () => {
        it('reads 1–6 the way parseInt did', () => {
            expect(parseSlot('1')).toBe(1);
            expect(parseSlot('6')).toBe(6);
            expect(parseSlot('3rd')).toBe(3);
        });

        it('rejects anything else', () => {
            for (const raw of [undefined, '', '0', '7', '-1', 'two']) expect(parseSlot(raw)).toBeNull();
        });
    });

    describe('slotForCatch', () => {
        it('fills the starter slot first, then the lowest free slot', () => {
            expect(slotForCatch([])).toBe(1);
            expect(slotForCatch([mon(2), mon(3)])).toBe(1);
            expect(slotForCatch([mon(1), mon(2), mon(4)])).toBe(3);
        });

        it('refuses a full team with the old copy', () => {
            const full = [1, 2, 3, 4, 5, 6].map(slot => mon(slot));
            expect(() => slotForCatch(full)).toThrow(
                "can't catch pokemon because no slots available. You need to delete one first.",
            );
        });
    });

    describe('planSwap', () => {
        it('returns the two Pokémon to exchange', () => {
            const [a, b] = planSwap([mon(1, 'A'), mon(4, 'B')], 1, 4);
            expect([a.name, b.name]).toEqual(['A', 'B']);
        });

        it.each([
            [[mon(1), mon(2)], 1, 1, "Can't swap to same slot"],
            [[], 1, 2, 'No pokemon to swap'],
            [[mon(1)], 1, 2, 'One of your slots has no pokemon'],
        ])('refuses %#', (team, a, b, message) => {
            expect(() => planSwap(team, a, b)).toThrow(new TeamRuleError(message));
        });
    });

    describe('planDelete', () => {
        it('is null for an empty slot', () => {
            expect(planDelete([mon(1)], 2)).toBeNull();
        });
    });

    describe('planCreateInSlot', () => {
        it('needs a starter before any other slot', () => {
            expect(() => planCreateInSlot([], 2)).toThrow('You must create a starter pokemon in slot 1 first');
            expect(() => planCreateInSlot([mon(2)], 3)).toThrow('You must create a starter pokemon in slot 1 first');
        });

        it('creates a starter into an empty team, and replaces what a slot holds', () => {
            expect(planCreateInSlot([], 1)).toBeNull();
            const starter = mon(1);
            expect(planCreateInSlot([starter], 1)).toBe(starter);
            expect(planCreateInSlot([starter], 5)).toBeNull();
        });

        it('rejects a slot outside 1–6', () => {
            expect(() => planCreateInSlot([], 7)).toThrow('Slot number must be between 1 & 6');
        });
    });
});
