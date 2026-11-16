/**
 * brobot's whole HTTP surface as route definitions, and the OpenAPI 3.1
 * document built from them (libs/contracts/docs/zod-source-of-truth.md). The
 * controllers validate with these routes' slots and are typed by their
 * responses (`RouteResult`), so a handler returning anything else does not
 * compile.
 *
 * Not served: the document is built by `brobotDocument()` for tests and
 * tooling. The streamer and overlay sockets are not HTTP and are not here.
 */
import { buildOpenApiDocument } from '@singularity/http-contract';
import type { OpenApiDocument } from '@singularity/http-contract';
import { authRoutes } from './auth';
import { commandsRoutes } from './commands';
import { healthRoutes } from './health';
import { horrorRoutes } from './horror';
import { pokemonRoutes } from './pokemon';
import { brobotInfo, brobotServers, globalSecurity, securitySchemes } from './security';
import { transferRoutes } from './transfer';

export const brobotTags = [
    { name: 'Health', description: 'Probes. Public and unthrottled.' },
    {
        name: 'Auth',
        description: 'Twitch sign-in, the streamer and bot token links, and the session.',
    },
    {
        name: 'Commands',
        description: "The chat commands and their switches (the admin site's commands page).",
    },
    { name: 'Pokemon', description: "The admin site's public Pokémon pages." },
    {
        name: 'Transfer',
        description: "api-time's side door: Pokémon travelling to and from pmd-online.",
    },
    { name: 'Horror', description: 'The SLEEP TIGHT gate, for the owner.' },
] as const;

export const brobotRoutes = [
    ...healthRoutes,
    ...authRoutes,
    ...commandsRoutes,
    ...pokemonRoutes,
    ...transferRoutes,
    ...horrorRoutes,
] as const;

export function brobotDocument(): OpenApiDocument {
    return buildOpenApiDocument({
        info: brobotInfo,
        servers: brobotServers,
        tags: brobotTags,
        securitySchemes,
        security: globalSecurity,
        routes: brobotRoutes,
    });
}
