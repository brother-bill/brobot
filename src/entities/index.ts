import { Pokemon } from './pokemon.entity';
import { PokemonBattleOutcome } from './pokemon-battle-outcome.entity';
import { PokemonTeam } from './pokemon-team.entity';
import { PokemonTeamBattleOutcome } from './pokemon-team-battle-outcome.entity';
import { TwitchBotAuth } from './twitch-bot-auth.entity';
import { TwitchStreamerAuth } from './twitch-streamer-auth.entity';
import { TwitchUser } from './twitch-user.entity';
import { TwitchUserRegistered } from './twitch-user-registered.entity';
import { TransferLog } from '../modules/transfer/entities/transfer-log.entity';

export * from './pokemon.entity';
export * from './pokemon-battle-outcome.entity';
export * from './pokemon-team.entity';
export * from './pokemon-team-battle-outcome.entity';
export * from './twitch-bot-auth.entity';
export * from './twitch-streamer-auth.entity';
export * from './twitch-user.entity';
export * from './twitch-user-registered.entity';

/**
 * Every entity, registered once here and used by both the Nest module and the
 * CLI config — the migration diff is built from this list, so an entity
 * missing from it is a table the owner's `migration:create` never sees.
 */
export const ENTITIES = [
    TwitchUser,
    TwitchUserRegistered,
    TwitchBotAuth,
    TwitchStreamerAuth,
    PokemonTeam,
    Pokemon,
    PokemonBattleOutcome,
    PokemonTeamBattleOutcome,
    // B3's transfer history; the entity lives in its module's lane.
    TransferLog,
];
