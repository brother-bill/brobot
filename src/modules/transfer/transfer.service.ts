import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Pokemon } from '../../entities/pokemon.entity';
import type { ActiveGame } from '../../entities/pokemon.entity';
import { TransferLog } from './entities/transfer-log.entity';
import type { TransferDirection } from './entities/transfer-log.entity';
import { decideDepart, decideReturn, TRANSFER_ERROR_CODES } from './transfer-rules';
import type { TransferDecision, TransferErrorCode, TransitionHistory } from './transfer-rules';
import type { DepartBody, ReturnBody } from './transfer.schemas';

/**
 * One brobot Pokémon as the internal transfer API returns it. Field names are
 * the contract (`BrobotPokemonSchema` in libs/pmd-contracts): renaming one
 * here breaks api-time.
 */
export interface TransferPokemon {
    id: string;
    nameId: string;
    dexNum: number;
    name: string;
    level: number;
    shiny: boolean;
    gender: string;
    nature: string;
    ability: string;
    item: string;
    moves: string[];
    types: string[];
    wins: number;
    losses: number;
    draws: number;
    activeGame: ActiveGame;
    pmdRegisterId: string | null;
    levelAtDeparture: number | null;
    createdDate: string;
}

export function toTransferPokemon(pokemon: Pokemon): TransferPokemon {
    return {
        id: pokemon.id,
        nameId: pokemon.name_id,
        dexNum: pokemon.dex_num,
        name: pokemon.name,
        level: pokemon.level,
        shiny: pokemon.shiny,
        gender: pokemon.gender,
        nature: pokemon.nature,
        ability: pokemon.ability,
        item: pokemon.item,
        moves: [...pokemon.moves],
        types: [...pokemon.types],
        wins: pokemon.wins,
        losses: pokemon.losses,
        draws: pokemon.draws,
        activeGame: pokemon.active_game,
        pmdRegisterId: pokemon.pmd_register_id ?? null,
        levelAtDeparture: pokemon.level_at_departure ?? null,
        createdDate: pokemon.created_date.toISOString(),
    };
}

const STATUS_NAMES = { 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict' } as const;

/** Nest's usual error body plus the machine-readable `code`. */
function keyedError(
    status: keyof typeof STATUS_NAMES,
    code: TransferErrorCode,
    message: string,
): HttpException {
    return new HttpException(
        { statusCode: status, error: STATUS_NAMES[status], code, message },
        status,
    );
}

/**
 * Moves Pokémon between brobot and pmd-online on api-time's word (plan §4).
 * api-time has already proved the player owns `twitchId`; brobot proves the
 * row belongs to `twitchId`. Each transition locks the row, decides with
 * `transfer-rules.ts`, and writes the flip and its `transfer_log` row in one
 * transaction — so two concurrent calls for one Pokémon serialise, and the
 * second sees the first's log row.
 */
@Injectable()
export class TransferService {
    private readonly logger = new Logger(TransferService.name);

    constructor(private readonly em: EntityManager) {}

    /** Every Pokémon of that Twitch user, in either game. An unknown user owns none. */
    async listForUser(twitchId: string): Promise<TransferPokemon[]> {
        const rows = await this.em
            .fork()
            .find(
                Pokemon,
                { twitch_user: twitchId },
                { orderBy: { created_date: 'asc', id: 'asc' } },
            );
        return rows.map(toTransferPokemon);
    }

    depart(id: string, body: DepartBody): Promise<TransferPokemon> {
        return this.transition(
            id,
            body.twitchId,
            'depart',
            body.nonce,
            body.pmdRegisterId,
            (pokemon, history) => decideDepart(pokemon, body, history, new Date()),
        );
    }

    return(id: string, body: ReturnBody): Promise<TransferPokemon> {
        return this.transition(
            id,
            body.twitchId,
            'return',
            body.nonce,
            body.pmdRegisterId,
            (pokemon, history) => decideReturn(pokemon, body, history),
        );
    }

    private async transition(
        id: string,
        twitchId: string,
        direction: TransferDirection,
        nonce: string,
        pmdRegisterId: string | null,
        decide: (pokemon: Pokemon, history: TransitionHistory) => TransferDecision,
    ): Promise<TransferPokemon> {
        return this.em.fork().transactional(async em => {
            const pokemon = await em.findOne(
                Pokemon,
                { id },
                { lockMode: LockMode.PESSIMISTIC_WRITE },
            );
            if (!pokemon)
                throw keyedError(404, TRANSFER_ERROR_CODES.notFound, 'no such brobot Pokémon');
            if (pokemon.twitch_user.oauth_id !== twitchId) {
                throw keyedError(
                    403,
                    TRANSFER_ERROR_CODES.notOwned,
                    'this Pokémon belongs to a different Twitch user',
                );
            }

            const sameNonce = await em.findOne(TransferLog, { pokemon: id, direction, nonce });
            const last = await em.findOne(
                TransferLog,
                { pokemon: id },
                { orderBy: { id: 'desc' } },
            );
            const decision = decide(pokemon, { sameNonce, last });

            if (decision.kind === 'refuse') throw keyedError(409, decision.code, decision.message);
            if (decision.kind === 'move') {
                em.assign(pokemon, decision.changes);
                em.create(TransferLog, {
                    pokemon,
                    direction,
                    nonce,
                    twitch_id: twitchId,
                    pmd_register_id: pmdRegisterId ?? pokemon.pmd_register_id ?? null,
                    level_before: decision.levelBefore,
                    level_after: decision.levelAfter,
                });
                this.logger.log(
                    `pokemon ${id} ${direction}: now in ${decision.changes.active_game}, level ${decision.levelBefore} → ${decision.levelAfter}`,
                );
            }
            return toTransferPokemon(pokemon);
        });
    }
}
