import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommandsModule } from '../commands/commands.module';
import { StreamerGateway } from './streamer.gateway';

/**
 * The bot itself — Twurple chat + EventSub, the `!pokemon` family, drops,
 * redeems, votes, chess, Streamlabs, the AI reply. B1 ships the shell: the
 * module is registered and the `/api/ashketchum` socket is live and
 * authenticated. B2 fills it, taking Twitch credentials from AuthModule's
 * `TwitchTokenStoreService` and command switches from CommandsModule.
 */
@Module({
    imports: [AuthModule, CommandsModule],
    providers: [StreamerGateway],
    exports: [StreamerGateway],
})
export class TwitchModule {}
