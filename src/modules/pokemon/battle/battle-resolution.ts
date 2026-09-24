import type { BattleResult } from './battle-simulator';

/**
 * A winner gains a level only when it is at most this many levels above the
 * Pokémon it beat (the old bot's rule: "over 20 levels higher … you ain't
 * leveling up from this one").
 */
export const MAX_LEVEL_GAP_FOR_GAIN = 20;

/** Ways a battle is won, picked at random for the result line. Verbatim from the old bot. */
export const BATTLE_FLOURISHES: readonly string[] = [
    'completely obliterated',
    'absolutely brutalized',
    'thoroughly whooped',
    'downright annihilated',
    'unreservedly decimated',
    'utterly devastated',
    'totally eradicated',
    'perfectly liquidated',
    'unconditionally demolished',
];

const SHINY_BANNER = 'PogChamp ****SHINY**** PogChamp';

export interface Fighter {
    id: string;
    name: string;
    level: number;
    shiny: boolean;
}

export interface Contender<P> {
    /** Chat login, as the player is named in the battle. */
    login: string;
    pokemon: P;
}

/** One row's record change. Applied atomically per row by the write service. */
export interface StatChange {
    id: string;
    wins: number;
    losses: number;
    draws: number;
    levels: number;
}

export interface Resolution {
    changes: StatChange[];
    /** Chat lines, in order. */
    messages: string[];
}

export interface ResolutionContext {
    /** `Details: <url>` is appended to the result line. */
    detailsUrl: string;
    /** One of {@link BATTLE_FLOURISHES}. */
    flourish: string;
}

export function levelGain(winnerLevel: number, loserLevel: number): number {
    return winnerLevel - loserLevel > MAX_LEVEL_GAP_FOR_GAIN ? 0 : 1;
}

function change(id: string, delta: Partial<Omit<StatChange, 'id'>>): StatChange {
    return { id, wins: 0, losses: 0, draws: 0, levels: 0, ...delta };
}

/**
 * `!pokemon battle`: the winner gets a win and (see {@link levelGain}) a
 * level, the loser a loss; a tie is a draw for both; an unreadable result
 * changes nothing.
 */
export function resolveOneVsOne(
    result: BattleResult,
    p1: Contender<Fighter>,
    p2: Contender<Fighter>,
    context: ResolutionContext,
): Resolution {
    const details = `Details: ${context.detailsUrl}`;
    const { outcome } = result;
    if (outcome.kind === 'tie') {
        return {
            changes: [change(p1.pokemon.id, { draws: 1 }), change(p2.pokemon.id, { draws: 1 })],
            messages: [`After ${result.turns} turns...it was a tie? ${details}`],
        };
    }
    if (outcome.kind === 'unknown') {
        return {
            changes: [],
            messages: [
                outcome.reason === 'unrecognised-winner'
                    ? 'Oof, could not determine winner. Report to the indie police'
                    : `Didn't win and didn't draw? Wut. ${details}`,
            ],
        };
    }

    const [winner, loser] = outcome.winner === 'p1' ? [p1, p2] : [p2, p1];
    const gain = levelGain(winner.pokemon.level, loser.pokemon.level);
    const how = result.finishingMove ? `used ${result.finishingMove} and` : 'somehow';
    const messages = [
        `On turn ${result.turns}, ${winner.login}'s Level ${winner.pokemon.level} ${
            winner.pokemon.shiny ? SHINY_BANNER : ''
        } ${winner.pokemon.name} ${how} ${context.flourish} ${loser.login}'s Level ${loser.pokemon.level} ${
            loser.pokemon.shiny ? '****SHINY****' : ''
        } ${loser.pokemon.name}! ${details}`,
        gain === 0
            ? `@${winner.login}, your pokemon is over ${MAX_LEVEL_GAP_FOR_GAIN} levels higher than your opponent's. You ain't leveling up from this one`
            : `@${winner.login}'s ${winner.pokemon.name} leveled up to ${winner.pokemon.level + gain}!`,
    ];
    return {
        changes: [change(winner.pokemon.id, { wins: 1, levels: gain }), change(loser.pokemon.id, { losses: 1 })],
        messages,
    };
}

/**
 * `!pokemon teambattle`: every Pokémon that fought on the winning side gets a
 * win, every one on the losing side a loss, nobody levels; a tie is a draw
 * for all of them.
 */
export function resolveTeamBattle(
    result: BattleResult,
    p1: Contender<Fighter[]>,
    p2: Contender<Fighter[]>,
    context: ResolutionContext,
): Resolution {
    const details = `Details: ${context.detailsUrl}`;
    const { outcome } = result;
    if (outcome.kind === 'tie') {
        return {
            changes: [...p1.pokemon, ...p2.pokemon].map(pokemon => change(pokemon.id, { draws: 1 })),
            messages: [`After ${result.turns} turns...it was a tie? ${details}`],
        };
    }
    if (outcome.kind === 'unknown') {
        return {
            changes: [],
            messages: [
                outcome.reason === 'unrecognised-winner'
                    ? 'Oof, could not determine winner. Try again next time or report to the indie police'
                    : `Didn't win and didn't draw? Wut. ${details}`,
            ],
        };
    }

    const [winner, loser] = outcome.winner === 'p1' ? [p1, p2] : [p2, p1];
    const totalLevel = (team: Fighter[]) => team.reduce((sum, pokemon) => sum + pokemon.level, 0);
    return {
        changes: [
            ...winner.pokemon.map(pokemon => change(pokemon.id, { wins: 1 })),
            ...loser.pokemon.map(pokemon => change(pokemon.id, { losses: 1 })),
        ],
        messages: [
            `On turn ${result.turns}, ${winner.login}'s team(+${totalLevel(winner.pokemon)}) ${context.flourish} ${
                loser.login
            }'s team(+${totalLevel(loser.pokemon)}). ${details}`,
        ],
    };
}
