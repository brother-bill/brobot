import { Entity, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';

/**
 * The log of the most recent `!pokemon teambattle` (6v6) (Prisma `PokemonTeamBattleOutcome`). A
 * single-row table: the bot overwrites it after each battle and the admin UI
 * reads it back.
 */
@Entity({ tableName: 'pokemon_team_battle_outcome' })
export class PokemonTeamBattleOutcome {
    [OptionalProps]?: 'id' | 'updated_date' | 'outcome';

    @PrimaryKey({ type: 'uuid' })
    id: string = randomUUID();

    @Property({ type: 'timestamptz', onUpdate: () => new Date() })
    updated_date: Date = new Date();

    /** Prisma `String[]` was a nullable `text[]`; B3's import writes `{}` for NULL. */
    @Property({ type: 'text[]', defaultRaw: `'{}'` })
    outcome: string[] = [];
}
