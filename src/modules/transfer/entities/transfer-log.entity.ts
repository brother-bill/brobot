import {
    BigIntType,
    Entity,
    Enum,
    Index,
    ManyToOne,
    OptionalProps,
    PrimaryKey,
    Property,
    Unique,
} from '@mikro-orm/core';
import type { Rel } from '@mikro-orm/core';
import { Pokemon } from '../../../entities/pokemon.entity';

/** Which way a Pokémon moved: `depart` = brobot → PMD, `return` = PMD → brobot. */
export const TRANSFER_DIRECTIONS = ['depart', 'return'] as const;
export type TransferDirection = (typeof TRANSFER_DIRECTIONS)[number];

/**
 * One `active_game` transition (migration plan §4), written in the same
 * transaction as the flip itself. A request that moves nothing (a replay, or
 * a call that finds the Pokémon already where it was asked to go) writes no
 * row, so this table is exactly the Pokémon's travel history.
 *
 * It is also the idempotency record: `(pokemon, direction, nonce)` is unique,
 * and the highest `id` per Pokémon is its last transition — the one a
 * repeated nonce replays. `id` is a sequence rather than a uuid so that
 * "last" never depends on two clocks agreeing.
 */
@Entity({ tableName: 'transfer_log' })
@Unique({
    name: 'transfer_log_pokemon_direction_nonce_unique',
    properties: ['pokemon', 'direction', 'nonce'],
})
@Index({ properties: ['pokemon', 'id'] })
export class TransferLog {
    [OptionalProps]?: 'id' | 'at';

    @PrimaryKey({ type: new BigIntType('number'), autoincrement: true })
    id!: number;

    @ManyToOne(() => Pokemon, {
        joinColumn: 'pokemon_id',
        deleteRule: 'cascade',
        updateRule: 'cascade',
    })
    pokemon!: Rel<Pokemon>;

    @Enum({ items: [...TRANSFER_DIRECTIONS] })
    direction!: TransferDirection;

    /** The caller's idempotency key (api-time's `Idempotency-Key`). */
    @Property({ type: 'text' })
    nonce!: string;

    /** The Twitch id api-time asserted as the owner. */
    @Property({ type: 'text' })
    twitch_id!: string;

    /** pmd-online's register row the Pokémon travelled as. */
    @Property({ type: 'uuid', nullable: true })
    pmd_register_id?: string | null;

    @Property({ type: 'integer' })
    level_before!: number;

    @Property({ type: 'integer' })
    level_after!: number;

    @Property({ type: 'timestamptz', defaultRaw: 'now()' })
    at: Date = new Date();
}
