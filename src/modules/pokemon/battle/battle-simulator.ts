import { Injectable } from '@nestjs/common';
import { BattleStreams, RandomPlayerAI, Teams } from '@pkmn/sim';
import type { PokemonSet, StatsTable } from '@pkmn/sim';

/** What the simulator needs of a stored Pokémon. */
export interface BattlePokemon {
    name: string;
    gender: string;
    moves: string[];
    ability: string;
    item: string;
    level: number;
    shiny: boolean;
    nature: string;
}

export interface BattleSide {
    /** The player's name in the log, and what `|win|` reports: the viewer's chat login. */
    name: string;
    team: BattlePokemon[];
}

export type BattleOutcome =
    | { kind: 'win'; winner: 'p1' | 'p2' }
    | { kind: 'tie' }
    /** `|win|` named somebody else, or the log ended with neither a win nor a tie. */
    | { kind: 'unknown'; reason: 'unrecognised-winner' | 'no-result' };

export interface BattleResult {
    outcome: BattleOutcome;
    /** Every chunk the omniscient stream produced, oldest first — the saved battle outcome. */
    log: string[];
    /** Number of `|turn|` markers seen. */
    turns: number;
    /** The move named on the last `|move|` line, e.g. `Ice Beam`. */
    finishingMove: string | null;
}

/** Runs a battle to its end. An interface so tests replace Pokémon Showdown with a script. */
export abstract class BattleRunner {
    abstract run(p1: BattleSide, p2: BattleSide): Promise<BattleResult>;
}

/**
 * The old bot's battle, on `@pkmn/sim`: a generation-4 custom game in which
 * both sides are played by `RandomPlayerAI`, with the stored level, nature,
 * ability, item and moves, and zero EVs/IVs.
 */
@Injectable()
export class ShowdownBattleRunner extends BattleRunner {
    async run(p1: BattleSide, p2: BattleSide): Promise<BattleResult> {
        const streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
        // The players answer each request on their own streams; they finish
        // when the battle does, which is what the omniscient loop waits for.
        void new RandomPlayerAI(streams.p1).start();
        void new RandomPlayerAI(streams.p2).start();

        const log: string[] = [];
        const consume = (async () => {
            for await (const chunk of streams.omniscient) log.push(chunk);
        })();

        await streams.omniscient.write(
            [
                `>start ${JSON.stringify({ formatid: 'gen4customgame' })}`,
                `>player p1 ${JSON.stringify({ name: p1.name, team: Teams.pack(p1.team.map(toSet)) })}`,
                `>player p2 ${JSON.stringify({ name: p2.name, team: Teams.pack(p2.team.map(toSet)) })}`,
            ].join('\n'),
        );
        await consume;
        return readLog(log, p1.name, p2.name);
    }
}

function toSet(pokemon: BattlePokemon): PokemonSet {
    return {
        name: pokemon.name,
        species: pokemon.name,
        gender: pokemon.gender,
        moves: pokemon.moves,
        ability: pokemon.ability,
        evs: {} as StatsTable,
        ivs: {} as StatsTable,
        item: pokemon.item,
        level: pokemon.level,
        shiny: pokemon.shiny,
        nature: pokemon.nature,
    };
}

/**
 * Reads the result out of a finished battle log. The old code matched the
 * winner with `includes`, so a player whose name contained the other's
 * (`bob` / `bobby`) could be credited with the other's win; names are now
 * compared exactly.
 */
export function readLog(log: readonly string[], p1Name: string, p2Name: string): BattleResult {
    const lines = log.flatMap(chunk => chunk.split('\n'));
    const turns = lines.filter(line => line.startsWith('|turn|')).length;

    const lastMove = lines.findLast(line => line.startsWith('|move|'));
    const finishingMove = lastMove?.split('|').at(3)?.trim();

    const winLine = lines.findLast(line => line.startsWith('|win|'));
    let outcome: BattleOutcome;
    if (winLine !== undefined) {
        const winner = winLine.slice('|win|'.length).trim();
        if (winner === p1Name) outcome = { kind: 'win', winner: 'p1' };
        else if (winner === p2Name) outcome = { kind: 'win', winner: 'p2' };
        else outcome = { kind: 'unknown', reason: 'unrecognised-winner' };
    } else if (lines.some(line => line === '|tie' || line.startsWith('|tie|'))) {
        outcome = { kind: 'tie' };
    } else {
        outcome = { kind: 'unknown', reason: 'no-result' };
    }

    return { outcome, log: [...log], turns, finishingMove: finishingMove?.length ? finishingMove : null };
}
