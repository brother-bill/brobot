import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceTokenGuard } from '../../transfer/service-token.guard';
import { HorrorModeService } from './horror-mode.service';
import type { HorrorMode } from './horror-mode.service';

/**
 * The SLEEP TIGHT gate, for the owner (friend-slop-1 docs/horror/TWITCH.md "brobot modes"):
 *
 *     GET  /api/internal/horror/mode                    -> {"mode":"off"|"rehearsal"|"live"}
 *     POST /api/internal/horror/mode {"mode":"live"}    -> the new mode (stored, survives a restart)
 *
 * Bearer `BROBOT_SERVICE_TOKEN`, like the other internal routes. Not on the public commands list, so viewers never
 * learn the event exists.
 */
@Controller('internal/horror')
@UseGuards(ServiceTokenGuard)
export class HorrorModeController {
    constructor(private readonly gate: HorrorModeService) {}

    @Get('mode')
    get(): { mode: HorrorMode } {
        return { mode: this.gate.mode };
    }

    @Post('mode')
    @HttpCode(200)
    async set(@Body() body: { mode?: unknown } | undefined): Promise<{ mode: HorrorMode }> {
        return { mode: await this.gate.setMode(body?.mode, 'owner (internal/horror/mode)') };
    }
}
