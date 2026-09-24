import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable, Logger } from '@nestjs/common';
import { Pokemon, PokemonBattleOutcome, PokemonTeam, PokemonTeamBattleOutcome, TwitchUser } from '../../entities';
import type { StatChange } from './battle/battle-resolution';
import { assertInBrobot, isAwayInPmd } from './exclusivity';
import type { NewPokemon } from './pokemon-factory';
import { inSlot, planCreateInSlot, planDelete, planSwap, slotForCatch, TeamRuleError } from './team-rules';

/** A viewer as chat or a redeem identifies them. */
export interface Trainer {
    oauthId: string;
    displayName: string;
}

export type BattleKind = 'single' | 'team';

/**
 * Every write the bot makes to Pokémon, teams and battle outcomes (the old
 * `TwitchPokemonService`). Each team change runs in one transaction that
 * locks the team row first, so two chat commands from the same viewer
 * cannot interleave.
 *
 * Rows are changed in place. The old service rewrote a whole team
 * (`deleteMany` + `createMany`) to swap two slots or replace one, which gave
 * every Pokémon on the team a new id; the id is now the Pokémon's identity
 * in pmd-online too (migration plan §4), so it must survive a swap.
 *
 * Every change goes through the exclusivity rule (`exclusivity.ts`): a
 * Pokémon away in PMD is never battled, swapped, deleted, replaced or
 * levelled.
 */
@Injectable()
export class PokemonWriteService {
    private readonly logger = new Logger(PokemonWriteService.name);

    constructor(private readonly em: EntityManager) {}

    /** The viewer's Pokémon by slot, or null when they have never had a team. */
    async team(oauthId: string): Promise<Pokemon[] | null> {
        const em = this.em.fork();
        const team = await em.findOne(PokemonTeam, { twitch_user: oauthId });
        if (!team) return null;
        return em.find(Pokemon, { team }, { orderBy: { slot: 'asc' } });
    }

    async starter(oauthId: string): Promise<Pokemon | null> {
        const team = await this.team(oauthId);
        return team ? (inSlot(team, 1) ?? null) : null;
    }

    /** A caught drop (or an admin's `!pokemon create`): slot 1 if free, else the lowest free slot. */
    async addCaught(trainer: Trainer, fresh: NewPokemon): Promise<Pokemon> {
        return this.em.fork().transactional(async em => {
            const team = await this.lockTeam(em, trainer, true);
            const current = await em.find(Pokemon, { team });
            const slot = slotForCatch(current);
            return em.create(Pokemon, { ...fresh, slot, team, twitch_user: team.twitch_user });
        });
    }

    /**
     * A `Pokemon Create` redeem: puts `fresh` in `slot`, replacing (deleting)
     * the Pokémon there. The starter must exist before any other slot.
     */
    async createInSlot(trainer: Trainer, fresh: NewPokemon, slot: number): Promise<Pokemon> {
        return this.em.fork().transactional(async em => {
            const team = await this.lockTeam(em, trainer, true);
            const current = await em.find(Pokemon, { team });
            const replaced = planCreateInSlot(current, slot);
            if (replaced) {
                em.remove(replaced);
                // The slot must be free before the new row claims it.
                await em.flush();
            }
            return em.create(Pokemon, { ...fresh, slot, team, twitch_user: team.twitch_user });
        });
    }

    async swap(oauthId: string, a: number, b: number): Promise<void> {
        await this.em.fork().transactional(async em => {
            const team = await this.lockTeam(em, oauthId, false);
            if (!team) throw new TeamRuleError('No team found');
            const [first, second] = planSwap(await em.find(Pokemon, { team }), a, b);
            first.slot = b;
            second.slot = a;
        });
    }

    /** Deletes the Pokémon in `slot`; null when the slot is empty. */
    async delete(oauthId: string, slot: number): Promise<Pokemon | null> {
        return this.em.fork().transactional(async em => {
            const team = await this.lockTeam(em, oauthId, false);
            if (!team) return null;
            const doomed = planDelete(await em.find(Pokemon, { team }), slot);
            if (doomed) em.remove(doomed);
            return doomed;
        });
    }

    /** The `Pokemon Level Up` redeem: +1 level for the starter. */
    async levelUpStarter(oauthId: string): Promise<Pokemon> {
        return this.em.fork().transactional(async em => {
            const team = await this.lockTeam(em, oauthId, false);
            const starter = team ? await em.findOne(Pokemon, { team, slot: 1 }) : null;
            if (!starter) throw new TeamRuleError('you have no starter pokemon in slot 1');
            assertInBrobot(starter, 'level-up');
            starter.level += 1;
            return starter;
        });
    }

    /**
     * Applies a battle's record changes. A Pokémon that left for PMD while the
     * battle ran keeps its record as it was; the rest are updated.
     */
    async applyBattle(changes: readonly StatChange[]): Promise<void> {
        if (changes.length === 0) return;
        const byId = new Map(changes.map(change => [change.id, change]));
        await this.em.fork().transactional(async em => {
            const rows = await em.find(
                Pokemon,
                { id: { $in: [...byId.keys()] } },
                { lockMode: LockMode.PESSIMISTIC_WRITE },
            );
            for (const row of rows) {
                const change = byId.get(row.id);
                if (!change) continue;
                if (isAwayInPmd(row)) {
                    this.logger.warn(`${row.name} (${row.id}) left for PMD mid-battle; its record is unchanged`);
                    continue;
                }
                row.wins += change.wins;
                row.losses += change.losses;
                row.draws += change.draws;
                row.level += change.levels;
            }
        });
    }

    /** Overwrites the single stored log of the last battle of that kind (the admin site reads it). */
    async saveOutcome(kind: BattleKind, log: string[]): Promise<void> {
        const em = this.em.fork();
        const entity = kind === 'single' ? PokemonBattleOutcome : PokemonTeamBattleOutcome;
        const existing = await em.findOne(entity, {}, { orderBy: { updated_date: 'desc' } });
        if (existing) {
            existing.outcome = log;
            existing.updated_date = new Date();
        } else {
            em.create(entity, { outcome: log });
        }
        await em.flush();
    }

    /**
     * Locks (and, when `create` is set, first creates) the trainer's team row.
     * Creating also creates the `twitch_user` row for a viewer brobot has not
     * seen before.
     */
    private async lockTeam(em: EntityManager, trainer: Trainer, create: true): Promise<PokemonTeam>;
    private async lockTeam(em: EntityManager, oauthId: string, create: false): Promise<PokemonTeam | null>;
    private async lockTeam(em: EntityManager, who: Trainer | string, create: boolean): Promise<PokemonTeam | null> {
        const oauthId = typeof who === 'string' ? who : who.oauthId;
        const locked = await em.findOne(
            PokemonTeam,
            { twitch_user: oauthId },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (locked || !create || typeof who === 'string') return locked;

        const user =
            (await em.findOne(TwitchUser, { oauth_id: oauthId })) ??
            em.create(TwitchUser, { oauth_id: oauthId, display_name: who.displayName });
        const team = em.create(PokemonTeam, { twitch_user: user });
        await em.flush();
        return team;
    }
}
