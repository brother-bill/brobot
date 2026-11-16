import { BadGatewayException, Controller, Get, NotFoundException, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { RouteInput, RouteResult } from '@singularity/http-contract';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { routes } from '../../http';
import { TwitchApiError } from '../auth/twitch-oauth.client';
import { PokemonReadService } from './pokemon-read.service';
import type { TeamResponse } from './pokemon-read.service';
import { TeamLookupService } from './team-lookup.service';

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
    leaderboard(): Promise<RouteResult<typeof routes.getLeaderboard>> {
        return this.pokemon.leaderboard();
    }

    /** 10 lookups per client per minute on top of the 60 s per-login cache. */
    @Get('teams')
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    async team(
        @Query(new ZodValidationPipe(routes.getTeam.query)) query: RouteInput<typeof routes.getTeam>['query'],
    ): Promise<RouteResult<typeof routes.getTeam>> {
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
    battleOutcome(): Promise<RouteResult<typeof routes.getBattleOutcome>> {
        return this.pokemon.battleOutcome();
    }

    @Get('team-battle-outcome')
    teamBattleOutcome(): Promise<RouteResult<typeof routes.getTeamBattleOutcome>> {
        return this.pokemon.teamBattleOutcome();
    }
}
