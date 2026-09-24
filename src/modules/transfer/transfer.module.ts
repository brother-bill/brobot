import { Module } from '@nestjs/common';
import { ServiceTokenGuard } from './service-token.guard';
import { TransferController } from './transfer.controller';
import { TransferService } from './transfer.service';

/**
 * Pokémon transfer between brobot and pmd-online (migration plan §4): the
 * `/api/internal/transfer/*` API api-time calls, the `active_game` state
 * machine behind it, and the `transfer_log` it writes. The Prisma-dump import
 * (`scripts/import-prisma-dump.ts`) keeps its row mappers in `import/`.
 */
@Module({
    controllers: [TransferController],
    providers: [ServiceTokenGuard, TransferService],
    exports: [ServiceTokenGuard],
})
export class TransferModule {}
