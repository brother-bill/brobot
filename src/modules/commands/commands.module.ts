import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommandRegistryService } from './command-registry.service';
import { CommandsController } from './commands.controller';

/** Exports the registry so the bot's chat handlers (TwitchModule) can ask whether a command is on. */
@Module({
    imports: [AuthModule],
    controllers: [CommandsController],
    providers: [CommandRegistryService],
    exports: [CommandRegistryService],
})
export class CommandsModule {}
