import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { RouteInput, RouteResult } from '@singularity/http-contract';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { routes } from '../../http';
import { ServiceTokenGuard } from './service-token.guard';
import { TransferService } from './transfer.service';

/**
 * `/api/internal/transfer` — api-time's side door into brobot (plan §2, §4).
 * Bearer `BROBOT_SERVICE_TOKEN` only; no user session ever reaches it.
 *
 * Not rate-limited: every player's request arrives from the one api-time
 * host, so the per-client default would throttle all of them together.
 *
 * A path parameter is validated on its own, by its property of the route's
 * `params` (an issue's `path` is then empty, as it always was).
 */
@Controller('internal/transfer')
@UseGuards(ServiceTokenGuard)
@SkipThrottle()
export class TransferController {
    constructor(private readonly transfer: TransferService) {}

    /** The path api-time's client calls (pmd-contracts). */
    @Get('users/:twitchId/pokemon')
    async listByPath(
        @Param('twitchId', new ZodValidationPipe(routes.listUserTransferPokemon.params.shape.twitchId))
        twitchId: RouteInput<typeof routes.listUserTransferPokemon>['params']['twitchId'],
    ): Promise<RouteResult<typeof routes.listUserTransferPokemon>> {
        return { pokemon: await this.transfer.listForUser(twitchId) };
    }

    /** Same answer, query-string form. */
    @Get('pokemon')
    async list(
        @Query(new ZodValidationPipe(routes.listTransferPokemon.query)) query: RouteInput<typeof routes.listTransferPokemon>['query'],
    ): Promise<RouteResult<typeof routes.listTransferPokemon>> {
        return { pokemon: await this.transfer.listForUser(query.twitchId) };
    }

    @Post('pokemon/:id/depart')
    @HttpCode(200)
    async depart(
        @Param('id', new ZodValidationPipe(routes.departPokemon.params.shape.id)) id: RouteInput<typeof routes.departPokemon>['params']['id'],
        @Body(new ZodValidationPipe(routes.departPokemon.body)) body: RouteInput<typeof routes.departPokemon>['body'],
    ): Promise<RouteResult<typeof routes.departPokemon>> {
        return { pokemon: await this.transfer.depart(id, body) };
    }

    @Post('pokemon/:id/return')
    @HttpCode(200)
    async return(
        @Param('id', new ZodValidationPipe(routes.returnPokemon.params.shape.id)) id: RouteInput<typeof routes.returnPokemon>['params']['id'],
        @Body(new ZodValidationPipe(routes.returnPokemon.body)) body: RouteInput<typeof routes.returnPokemon>['body'],
    ): Promise<RouteResult<typeof routes.returnPokemon>> {
        return { pokemon: await this.transfer.return(id, body) };
    }
}
