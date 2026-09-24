import { Check, Entity, Enum, Index, ManyToOne, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core';
import type { Rel } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { PokemonTeam } from './pokemon-team.entity';
import { TwitchUser } from './twitch-user.entity';

/**
 * Which game currently holds a Pokémon (migration plan §4). `brobot` is the
 * only state the bot may battle, swap, delete or slot; `pmd` means it is away
 * in pmd-online and brobot must treat it as read-only. This column is the
 * single source of truth for that exclusivity — pmd-online's register row
 * mirrors it, never the other way round.
 */
export const ACTIVE_GAMES = ['brobot', 'pmd'] as const;
export type ActiveGame = (typeof ACTIVE_GAMES)[number];

/**
 * A caught/created Pokémon (Prisma `Pokemon`), plus the four §4 transfer
 * columns. The row uuid is the Pokémon's identity forever, including in
 * pmd-online (`pmd_registered_pokemon.originKey`).
 *
 * `level` is deliberately unbounded: the 100 cap is PMD's rule, applied when a
 * Pokémon is brought there, and brobot levels past it (the leaderboard sorts
 * on this column).
 */
@Entity({ tableName: 'pokemon' })
@Check({ name: 'pokemon_slot_check', expression: 'slot between 1 and 6' })
@Index({ properties: ['level'] })
// Postgres does not index foreign keys; team pages and the bot look Pokémon up by both.
@Index({ properties: ['team'] })
@Index({ properties: ['twitch_user'] })
export class Pokemon {
    [OptionalProps]?: 'id' | 'level' | 'wins' | 'losses' | 'draws' | 'item' | 'moves' | 'types' | 'created_date' | 'updated_date' | 'active_game';

    @PrimaryKey({ type: 'uuid' })
    id: string = randomUUID();

    @Property({ type: 'text' })
    name!: string;

    /** `@pkmn` species id, e.g. `pikachu`. */
    @Property({ type: 'text' })
    name_id!: string;

    /** Team slot, 1–6 (enforced by `pokemon_slot_check`; the old schema had no constraint). */
    @Property({ type: 'integer' })
    slot!: number;

    @Property({ type: 'integer', default: 1 })
    level = 1;

    @Property({ type: 'boolean' })
    shiny!: boolean;

    @Property({ type: 'integer', default: 0 })
    wins = 0;

    @Property({ type: 'integer', default: 0 })
    losses = 0;

    @Property({ type: 'integer', default: 0 })
    draws = 0;

    @Property({ type: 'text', default: '' })
    item = '';

    /** Prisma `String[]` was a nullable `text[]`; B3's import writes `{}` for NULL. */
    @Property({ type: 'text[]', defaultRaw: `'{}'` })
    moves: string[] = [];

    @Property({ type: 'integer' })
    dex_num!: number;

    @Property({ type: 'text' })
    color!: string;

    /** Prisma `String[]` was a nullable `text[]`; B3's import writes `{}` for NULL. */
    @Property({ type: 'text[]', defaultRaw: `'{}'` })
    types: string[] = [];

    /** 'M', 'F' or 'N'. */
    @Property({ type: 'text' })
    gender!: string;

    @Property({ type: 'text' })
    nature!: string;

    @Property({ type: 'text' })
    ability!: string;

    @ManyToOne(() => PokemonTeam, {
        nullable: true,
        joinColumn: 'team_id',
        deleteRule: 'set null',
        updateRule: 'cascade',
    })
    team?: Rel<PokemonTeam> | null;

    @ManyToOne(() => TwitchUser, {
        joinColumn: 'user_oauth_id',
        deleteRule: 'cascade',
        updateRule: 'cascade',
    })
    twitch_user!: Rel<TwitchUser>;

    @Property({ type: 'timestamptz', defaultRaw: 'now()' })
    created_date: Date = new Date();

    @Property({ type: 'timestamptz', onUpdate: () => new Date() })
    updated_date: Date = new Date();

    // ── Transfer columns (migration plan §4) ─────────────────────────────

    /** A text column with an `in ('brobot','pmd')` check, which is how MikroORM maps a string enum. */
    @Enum({ items: [...ACTIVE_GAMES], default: 'brobot' })
    active_game: ActiveGame = 'brobot';

    /** pmd-online's `pmd_registered_pokemon.id` once it has been brought there. */
    @Property({ type: 'uuid', nullable: true })
    pmd_register_id?: string | null;

    /** First time it was ever brought to PMD; never cleared. */
    @Property({ type: 'timestamptz', nullable: true })
    pmd_first_transferred_at?: Date | null;

    /**
     * brobot level at the moment it last left for PMD — what send-back compares
     * against so levels carry but never regress (§4).
     */
    @Property({ type: 'integer', nullable: true })
    level_at_departure?: number | null;
}
