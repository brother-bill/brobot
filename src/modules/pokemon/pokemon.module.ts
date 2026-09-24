import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PokemonController } from './pokemon.controller';
import { PokemonReadService } from './pokemon-read.service';
import { TeamLookupService } from './team-lookup.service';

/** HTTP reads for the admin site. The bot's Pokémon logic (B2) and transfers (B3) live elsewhere. */
@Module({
    imports: [AuthModule],
    controllers: [PokemonController],
    providers: [PokemonReadService, TeamLookupService],
    exports: [PokemonReadService],
})
export class PokemonModule {}
