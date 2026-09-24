import { BadGatewayException, Controller, Get, NotFoundException, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TwitchApiError } from '../auth/twitch-oauth.client';
import { PokemonReadService } from './pokemon-read.service';
import type { BattleOutcomeResponse, LeaderboardEntry, TeamResponse } from './pokemon-read.service';
import { TeamLookupService } from './team-lookup.service';

/** Twitch logins are 1–25 of `[A-Za-z0-9_]`; anything else cannot exist and never reaches Twitch. */
const teamsQuerySchema = z.object({
    login: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_]{1,25}$/, 'must be a Twitch login'),
});

/**
 * Public read endpoints for the admin site's Pokémon pages. Public because
 * they were public in the old app (`!pokemon team` links viewers to them).
 */
@Controller('pokemon')
export class PokemonController {
    constructor(
        private readonly pokemon: PokemonReadService,
        private readonly teams: TeamLookupService,
    ) {}

    @Get('leaderboard')
    leaderboard(): Promise<LeaderboardEntry[]> {
        return this.pokemon.leaderboard();
    }

    /** 10 lookups per client per minute on top of the 60 s per-login cache. */
    @Get('teams')
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    async team(
        @Query(new ZodValidationPipe(teamsQuerySchema)) query: z.infer<typeof teamsQuerySchema>,
    ): Promise<TeamResponse> {
        let team: TeamResponse | null;
        try {
            team = await this.teams.findByLogin(query.login);
        } catch (error) {
            if (error instanceof TwitchApiError) throw new BadGatewayException('Twitch lookup failed');
            throw error;
        }
        if (!team) throw new NotFoundException('No brobot user with that login');
        return team;
    }

    @Get('battle-outcome')
    battleOutcome(): Promise<BattleOutcomeResponse> {
        return this.pokemon.battleOutcome();
    }

    @Get('team-battle-outcome')
    teamBattleOutcome(): Promise<BattleOutcomeResponse> {
        return this.pokemon.teamBattleOutcome();
    }
}
