import { levelGain, resolveOneVsOne, resolveTeamBattle } from './battle-resolution';
import type { Fighter } from './battle-resolution';
import { readLog, ShowdownBattleRunner } from './battle-simulator';
import type { BattleResult } from './battle-simulator';

const fighter = (id: string, name: string, level: number, shiny = false): Fighter => ({ id, name, level, shiny });
const context = { detailsUrl: 'https://brobot.test/pokemon/battleoutcome', flourish: 'totally eradicated' };

function result(outcome: BattleResult['outcome'], finishingMove: string | null = 'Thunderbolt'): BattleResult {
    return { outcome, log: [], turns: 6, finishingMove };
}

describe('battle resolution', () => {
    const ash = { login: 'ash', pokemon: fighter('a', 'Pikachu', 12) };
    const gary = { login: 'gary', pokemon: fighter('g', 'Eevee', 10, true) };

    describe('levelGain', () => {
        it('gives the winner a level unless it is more than 20 above the loser', () => {
            expect(levelGain(10, 10)).toBe(1);
            expect(levelGain(5, 50)).toBe(1);
            expect(levelGain(30, 10)).toBe(1);
            expect(levelGain(31, 10)).toBe(0);
        });
    });

    describe('1v1', () => {
        it('credits the winner with a win and a level, the loser with a loss', () => {
            const resolution = resolveOneVsOne(result({ kind: 'win', winner: 'p1' }), ash, gary, context);
            expect(resolution.changes).toEqual([
                { id: 'a', wins: 1, losses: 0, draws: 0, levels: 1 },
                { id: 'g', wins: 0, losses: 1, draws: 0, levels: 0 },
            ]);
            expect(resolution.messages).toEqual([
                "On turn 6, ash's Level 12  Pikachu used Thunderbolt and totally eradicated gary's Level 10 ****SHINY**** Eevee! Details: https://brobot.test/pokemon/battleoutcome",
                "@ash's Pikachu leveled up to 13!",
            ]);
        });

        it('works the same way round when p2 wins', () => {
            const resolution = resolveOneVsOne(result({ kind: 'win', winner: 'p2' }, null), ash, gary, context);
            expect(resolution.changes.map(change => [change.id, change.wins, change.losses])).toEqual([
                ['g', 1, 0],
                ['a', 0, 1],
            ]);
            expect(resolution.messages[0]).toContain("gary's Level 10 PogChamp ****SHINY**** PogChamp Eevee somehow totally eradicated ash's");
        });

        it('withholds the level from a winner more than 20 levels above', () => {
            const big = { login: 'red', pokemon: fighter('r', 'Charizard', 60) };
            const resolution = resolveOneVsOne(result({ kind: 'win', winner: 'p1' }), big, gary, context);
            expect(resolution.changes[0]).toMatchObject({ id: 'r', wins: 1, levels: 0 });
            expect(resolution.messages[1]).toBe(
                "@red, your pokemon is over 20 levels higher than your opponent's. You ain't leveling up from this one",
            );
        });

        it('gives both a draw on a tie', () => {
            const resolution = resolveOneVsOne(result({ kind: 'tie' }), ash, gary, context);
            expect(resolution.changes).toEqual([
                { id: 'a', wins: 0, losses: 0, draws: 1, levels: 0 },
                { id: 'g', wins: 0, losses: 0, draws: 1, levels: 0 },
            ]);
            expect(resolution.messages).toEqual([
                'After 6 turns...it was a tie? Details: https://brobot.test/pokemon/battleoutcome',
            ]);
        });

        it('changes nothing when the result cannot be read', () => {
            expect(resolveOneVsOne(result({ kind: 'unknown', reason: 'unrecognised-winner' }), ash, gary, context)).toEqual({
                changes: [],
                messages: ['Oof, could not determine winner. Report to the indie police'],
            });
            expect(resolveOneVsOne(result({ kind: 'unknown', reason: 'no-result' }), ash, gary, context).messages).toEqual([
                "Didn't win and didn't draw? Wut. Details: https://brobot.test/pokemon/battleoutcome",
            ]);
        });
    });

    describe('team battle', () => {
        const ashTeam = { login: 'ash', pokemon: [fighter('a1', 'Pikachu', 12), fighter('a2', 'Onix', 20)] };
        const garyTeam = { login: 'gary', pokemon: [fighter('g1', 'Eevee', 30)] };

        it('gives every winner a win and every loser a loss, and no levels', () => {
            const resolution = resolveTeamBattle(result({ kind: 'win', winner: 'p2' }), ashTeam, garyTeam, context);
            expect(resolution.changes).toEqual([
                { id: 'g1', wins: 1, losses: 0, draws: 0, levels: 0 },
                { id: 'a1', wins: 0, losses: 1, draws: 0, levels: 0 },
                { id: 'a2', wins: 0, losses: 1, draws: 0, levels: 0 },
            ]);
            expect(resolution.messages).toEqual([
                "On turn 6, gary's team(+30) totally eradicated ash's team(+32). Details: https://brobot.test/pokemon/battleoutcome",
            ]);
        });

        it('draws everybody on a tie', () => {
            const resolution = resolveTeamBattle(result({ kind: 'tie' }), ashTeam, garyTeam, context);
            expect(resolution.changes.every(change => change.draws === 1)).toBe(true);
            expect(resolution.changes).toHaveLength(3);
        });

        it('has its own copy for an unreadable winner', () => {
            expect(
                resolveTeamBattle(result({ kind: 'unknown', reason: 'unrecognised-winner' }), ashTeam, garyTeam, context)
                    .messages,
            ).toEqual(['Oof, could not determine winner. Try again next time or report to the indie police']);
        });
    });
});

describe('readLog', () => {
    const chunks = [
        'update\n|player|p1|bob\n|player|p2|bobby\n|turn|1',
        '|move|p1a: Pikachu|Thunderbolt|p2a: Eevee\n|turn|2',
        '|move|p2a: Eevee|Quick Attack|p1a: Pikachu\n|-damage|p1a: Pikachu|0 fnt\n|faint|p1a: Pikachu\n|\n|win|bobby',
    ];

    it('counts turns, finds the finishing move, and names the winner exactly', () => {
        const read = readLog(chunks, 'bob', 'bobby');
        expect(read.turns).toBe(2);
        expect(read.finishingMove).toBe('Quick Attack');
        // The old `includes` check would have credited "bob" with "bobby"'s win.
        expect(read.outcome).toEqual({ kind: 'win', winner: 'p2' });
        expect(read.log).toEqual(chunks);
    });

    it('reads a tie', () => {
        expect(readLog(['|turn|1\n|tie'], 'a', 'b').outcome).toEqual({ kind: 'tie' });
    });

    it('reports a winner it does not know, and a log with no result', () => {
        expect(readLog(['|win|mallory'], 'a', 'b').outcome).toEqual({ kind: 'unknown', reason: 'unrecognised-winner' });
        expect(readLog(['|turn|1'], 'a', 'b')).toMatchObject({
            outcome: { kind: 'unknown', reason: 'no-result' },
            finishingMove: null,
        });
    });
});

describe('ShowdownBattleRunner', () => {
    it('plays a real generation-4 battle to a result', async () => {
        const side = (name: string, species: string) => ({
            name,
            team: [
                {
                    name: species,
                    gender: 'M',
                    moves: ['tackle', 'thundershock', 'quickattack', 'growl'],
                    ability: 'Static',
                    item: '',
                    level: 10,
                    shiny: false,
                    nature: 'Adamant',
                },
            ],
        });
        const outcome = await new ShowdownBattleRunner().run(side('ash', 'Pikachu'), side('gary', 'Pichu'));
        expect(outcome.log.length).toBeGreaterThan(0);
        expect(outcome.turns).toBeGreaterThan(0);
        expect(['win', 'tie']).toContain(outcome.outcome.kind);
    }, 30_000);
});
