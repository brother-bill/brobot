import { Entity, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';

/**
 * The log of the most recent `!pokemon battle` (1v1) (Prisma `PokemonBattleOutcome`). A
 * single-row table: the bot overwrites it after each battle and the admin UI
 * reads it back.
 */
@Entity({ tableName: 'pokemon_battle_outcome' })
export class PokemonBattleOutcome {
    [OptionalProps]?: 'id' | 'updated_date' | 'outcome';

    @PrimaryKey({ type: 'uuid' })
    id: string = randomUUID();

    @Property({ type: 'timestamptz', onUpdate: () => new Date() })
    updated_date: Date = new Date();

    /** Prisma `String[]` was a nullable `text[]`; B3's import writes `{}` for NULL. */
    @Property({ type: 'text[]', defaultRaw: `'{}'` })
    outcome: string[] = [];
}
