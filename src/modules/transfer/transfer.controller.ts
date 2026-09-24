import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ServiceTokenGuard } from './service-token.guard';
import {
    departBodySchema,
    pokemonIdParamSchema,
    returnBodySchema,
    twitchIdQuerySchema,
    twitchIdSchema,
} from './transfer.schemas';
import type { DepartBody, ReturnBody } from './transfer.schemas';
import { TransferService } from './transfer.service';
import type { TransferPokemon } from './transfer.service';

/**
 * `/api/internal/transfer` — api-time's side door into brobot (plan §2, §4).
 * Bearer `BROBOT_SERVICE_TOKEN` only; no user session ever reaches it.
 *
 * Not rate-limited: every player's request arrives from the one api-time
 * host, so the per-client default would throttle all of them together.
 */
@Controller('internal/transfer')
@UseGuards(ServiceTokenGuard)
@SkipThrottle()
export class TransferController {
    constructor(private readonly transfer: TransferService) {}

    /** The path api-time's client calls (pmd-contracts). */
    @Get('users/:twitchId/pokemon')
    async listByPath(
        @Param('twitchId', new ZodValidationPipe(twitchIdSchema)) twitchId: string,
    ): Promise<{ pokemon: TransferPokemon[] }> {
        return { pokemon: await this.transfer.listForUser(twitchId) };
    }

    /** Same answer, query-string form. */
    @Get('pokemon')
    async list(
        @Query(new ZodValidationPipe(twitchIdQuerySchema)) query: { twitchId: string },
    ): Promise<{ pokemon: TransferPokemon[] }> {
        return { pokemon: await this.transfer.listForUser(query.twitchId) };
    }

    @Post('pokemon/:id/depart')
    @HttpCode(200)
    async depart(
        @Param('id', new ZodValidationPipe(pokemonIdParamSchema)) id: string,
        @Body(new ZodValidationPipe(departBodySchema)) body: DepartBody,
    ): Promise<{ pokemon: TransferPokemon }> {
        return { pokemon: await this.transfer.depart(id, body) };
    }

    @Post('pokemon/:id/return')
    @HttpCode(200)
    async return(
        @Param('id', new ZodValidationPipe(pokemonIdParamSchema)) id: string,
        @Body(new ZodValidationPipe(returnBodySchema)) body: ReturnBody,
    ): Promise<{ pokemon: TransferPokemon }> {
        return { pokemon: await this.transfer.return(id, body) };
    }
}
