import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { RouteResult } from '@singularity/http-contract';
import { routes } from '../../../http';
import { ServiceTokenGuard } from '../../transfer/service-token.guard';
import { HorrorModeService } from './horror-mode.service';

/**
 * The SLEEP TIGHT gate, for the owner (friend-slop-1 docs/horror/TWITCH.md "brobot modes"):
 *
 *     GET  /api/internal/horror/mode                    -> {"mode":"off"|"rehearsal"|"live"}
 *     POST /api/internal/horror/mode {"mode":"live"}    -> the new mode (stored, survives a restart)
 *
 * Bearer `BROBOT_SERVICE_TOKEN`, like the other internal routes. Not on the public commands list, so viewers never
 * learn the event exists.
 *
 * The POST body is not validated here: {@link HorrorModeService.setMode} parses `mode` itself and answers 400 with
 * its own message. The route (`src/http/horror.ts`) documents the `{ mode }` it accepts.
 */
@Controller('internal/horror')
@UseGuards(ServiceTokenGuard)
export class HorrorModeController {
    constructor(private readonly gate: HorrorModeService) {}

    @Get('mode')
    get(): RouteResult<typeof routes.getHorrorMode> {
        return { mode: this.gate.mode };
    }

    @Post('mode')
    @HttpCode(200)
    async set(@Body() body: { mode?: unknown } | undefined): Promise<RouteResult<typeof routes.setHorrorMode>> {
        return { mode: await this.gate.setMode(body?.mode, 'owner (internal/horror/mode)') };
    }
}
