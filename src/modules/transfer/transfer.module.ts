import { Module } from '@nestjs/common';
import { ServiceTokenGuard } from './service-token.guard';

/**
 * Pokémon transfer between brobot and pmd-online (migration plan §4). B1
 * registers the module and its guard; B3 adds the `/api/internal/transfer/*`
 * controller, the `active_game` state machine and the Prisma-dump import
 * here, without touching app.module.ts.
 */
@Module({
    providers: [ServiceTokenGuard],
    exports: [ServiceTokenGuard],
})
export class TransferModule {}
