import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { Pokemon, PokemonBattleOutcome, PokemonTeamBattleOutcome, TwitchUser } from '../../entities';
import type { ActiveGame } from '../../entities';

export const LEADERBOARD_SIZE = 30;

export interface LeaderboardEntry {
    level: number;
    name: string;
    nameId: string;
    shiny: boolean;
    activeGame: ActiveGame;
    twitchUser: { displayName: string };
}

export interface BattleOutcomeResponse {
    /** The battle log lines, oldest first. Empty when no battle has been fought yet. */
    outcome: string[];
    updatedDate: string | null;
}

/** A Pokémon as the team page shows it. No ids: the old endpoint hid them too. */
export interface TeamPokemon {
    name: string;
    nameId: string;
    slot: number;
    level: number;
    shiny: boolean;
    wins: number;
    losses: number;
    draws: number;
    item: string;
    moves: string[];
    dexNum: number;
    color: string;
    types: string[];
    gender: string;
    nature: string;
    ability: string;
    /** `pmd` = away in pmd-online (migration plan §4); the team page shows it as such. */
    activeGame: ActiveGame;
    createdDate: string;
    updatedDate: string;
}

export interface TeamResponse {
    displayName: string;
    /** Null when the user exists but has never had a team. */
    pokemonTeam: { pokemon: TeamPokemon[] } | null;
}

/** The read-only Pokémon queries behind the admin site. Writes belong to the bot (B2). */
@Injectable()
export class PokemonReadService {
    constructor(private readonly em: EntityManager) {}

    /** Highest levels first; ties go to the Pokémon that got there first. */
    async leaderboard(): Promise<LeaderboardEntry[]> {
        const rows = await this.em.fork().find(
            Pokemon,
            {},
            {
                orderBy: { level: 'desc', created_date: 'asc' },
                limit: LEADERBOARD_SIZE,
                populate: ['twitch_user'],
            },
        );
        return rows.map(pokemon => ({
            level: pokemon.level,
            name: pokemon.name,
            nameId: pokemon.name_id,
            shiny: pokemon.shiny,
            activeGame: pokemon.active_game,
            twitchUser: { displayName: pokemon.twitch_user.display_name },
        }));
    }

    async battleOutcome(): Promise<BattleOutcomeResponse> {
        return toOutcome(await this.em.fork().findOne(PokemonBattleOutcome, {}, { orderBy: { updated_date: 'desc' } }));
    }

    async teamBattleOutcome(): Promise<BattleOutcomeResponse> {
        return toOutcome(
            await this.em.fork().findOne(PokemonTeamBattleOutcome, {}, { orderBy: { updated_date: 'desc' } }),
        );
    }

    /** The team of the Twitch user with this id, or null if brobot has never seen them. */
    async teamByOauthId(oauthId: string): Promise<TeamResponse | null> {
        const user = await this.em
            .fork()
            .findOne(TwitchUser, { oauth_id: oauthId }, { populate: ['pokemon_team', 'pokemon_team.pokemon'] });
        if (!user) return null;
        const team = user.pokemon_team;
        return {
            displayName: user.display_name,
            pokemonTeam: team
                ? {
                      pokemon: team.pokemon
                          .getItems()
                          .sort((a, b) => a.slot - b.slot)
                          .map(toTeamPokemon),
                  }
                : null,
        };
    }
}

function toOutcome(row: { outcome: string[]; updated_date: Date } | null): BattleOutcomeResponse {
    return row ? { outcome: [...row.outcome], updatedDate: row.updated_date.toISOString() } : { outcome: [], updatedDate: null };
}

function toTeamPokemon(pokemon: Pokemon): TeamPokemon {
    return {
        name: pokemon.name,
        nameId: pokemon.name_id,
        slot: pokemon.slot,
        level: pokemon.level,
        shiny: pokemon.shiny,
        wins: pokemon.wins,
        losses: pokemon.losses,
        draws: pokemon.draws,
        item: pokemon.item,
        moves: [...pokemon.moves],
        dexNum: pokemon.dex_num,
        color: pokemon.color,
        types: [...pokemon.types],
        gender: pokemon.gender,
        nature: pokemon.nature,
        ability: pokemon.ability,
        activeGame: pokemon.active_game,
        createdDate: pokemon.created_date.toISOString(),
        updatedDate: pokemon.updated_date.toISOString(),
    };
}
