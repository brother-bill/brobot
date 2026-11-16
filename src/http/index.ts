/**
 * The route definitions by operationId, for the controllers:
 * `new ZodValidationPipe(routes.getTeam.query)`, and
 * `Promise<RouteResult<typeof routes.getTeam>>` as the handler's type.
 */
import {
    getAuthStatus,
    logout,
    refreshSession,
    refreshTwitchSession,
    twitchBotCallback,
    twitchBotLink,
    twitchCallback,
    twitchLogin,
    twitchStreamerCallback,
    twitchStreamerLink,
} from './auth';
import { listCommands, setCommandEnabled } from './commands';
import { getHealth, getLiveness } from './health';
import { getHorrorMode, setHorrorMode } from './horror';
import { getBattleOutcome, getLeaderboard, getTeam, getTeamBattleOutcome } from './pokemon';
import {
    departPokemon,
    listTransferPokemon,
    listUserTransferPokemon,
    returnPokemon,
} from './transfer';

export const routes = {
    getHealth,
    getLiveness,
    twitchLogin,
    twitchCallback,
    twitchStreamerLink,
    twitchStreamerCallback,
    twitchBotLink,
    twitchBotCallback,
    getAuthStatus,
    refreshTwitchSession,
    logout,
    refreshSession,
    listCommands,
    setCommandEnabled,
    getLeaderboard,
    getTeam,
    getBattleOutcome,
    getTeamBattleOutcome,
    listUserTransferPokemon,
    listTransferPokemon,
    departPokemon,
    returnPokemon,
    getHorrorMode,
    setHorrorMode,
} as const;

export { brobotDocument, brobotRoutes, brobotTags } from './document';
