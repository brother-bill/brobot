import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommandsModule } from '../commands/commands.module';
import { PokemonModule } from '../pokemon/pokemon.module';
import { BotChatService } from './chat/bot-chat.service';
import { EventSubService } from './eventsub.service';
import { AiCompleter, AiReplyService, OpenAiCompleter } from './fun/ai-reply.service';
import { ChessService } from './fun/chess.service';
import { FunCommandsService } from './fun/fun-commands.service';
import { GoLiveService } from './go-live/go-live.service';
import { OverlayGateway } from './overlay.gateway';
import { PokemonBattlesService } from './pokemon/pokemon-battles.service';
import { PokemonCommandsService } from './pokemon/pokemon-commands.service';
import { PokemonDropsService } from './pokemon/pokemon-drops.service';
import { PokemonRedeemsService } from './redeems/pokemon-redeems.service';
import { REDEMPTION_SETTLER } from './redeems/redemption';
import { HorrorRedeemsService } from './redeems/horror-redeems.service';
import { HORROR_REWARD_API, HorrorRewardsService } from './redeems/horror-rewards.service';
import { RedemptionsService } from './redeems/redemptions.service';
import { StreamerApiService } from './streamer-api.service';
import { StreamerGateway } from './streamer.gateway';
import { UiLinks } from './ui-links';
import { VotesService } from './votes/votes.service';

/**
 * The bot: Twurple chat and EventSub, the `!pokemon` family, drops,
 * channel-point redeems, `!chatban` / `!voiceban` over `/api/ashketchum`,
 * the stream overlay socket, chess, the AI reply and the Discord go-live
 * announcement.
 *
 * Credentials come from AuthModule's token stores, switches from
 * CommandsModule, and the game from PokemonModule. With
 * `TWITCH_BOT_ENABLED=false` every service is still built (so a DI break
 * shows up in the boot test) but nothing connects to Twitch.
 */
@Module({
    imports: [AuthModule, CommandsModule, PokemonModule],
    providers: [
        StreamerGateway,
        OverlayGateway,
        BotChatService,
        StreamerApiService,
        { provide: REDEMPTION_SETTLER, useExisting: StreamerApiService },
        { provide: HORROR_REWARD_API, useExisting: StreamerApiService },
        HorrorRewardsService,
        UiLinks,
        VotesService,
        PokemonBattlesService,
        PokemonDropsService,
        PokemonCommandsService,
        PokemonRedeemsService,
        FunCommandsService,
        ChessService,
        { provide: AiCompleter, useClass: OpenAiCompleter },
        AiReplyService,
        RedemptionsService,
        HorrorRedeemsService,
        GoLiveService,
        EventSubService,
    ],
    exports: [StreamerGateway, BotChatService, EventSubService],
})
export class TwitchModule {}
