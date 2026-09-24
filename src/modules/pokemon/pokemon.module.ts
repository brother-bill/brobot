import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BattleRunner, ShowdownBattleRunner } from './battle/battle-simulator';
import { PokemonController } from './pokemon.controller';
import { PokemonFactory } from './pokemon-factory';
import { PokemonReadService } from './pokemon-read.service';
import { PokemonWriteService } from './pokemon-write.service';
import { Random } from './random';
import { TeamLookupService } from './team-lookup.service';

/**
 * Pokémon: the admin site's HTTP reads, and the game itself — generating
 * Pokémon, the team rules, the exclusivity rule and battles — which the bot
 * (TwitchModule) drives from chat and redeems. Nothing here talks to Twitch.
 * Transfers (B3) live in TransferModule.
 */
@Module({
    imports: [AuthModule],
    controllers: [PokemonController],
    providers: [
        PokemonReadService,
        TeamLookupService,
        PokemonWriteService,
        PokemonFactory,
        Random,
        { provide: BattleRunner, useClass: ShowdownBattleRunner },
    ],
    exports: [PokemonReadService, PokemonWriteService, PokemonFactory, Random, BattleRunner],
})
export class PokemonModule {}
