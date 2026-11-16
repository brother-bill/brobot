/**
 * brobot's security schemes and its document-level defaults, for
 * `brobotDocument()` (`./document.ts`). A route names a scheme by its key
 * here; `requires(...)` is checked against the keys when it compiles, and the
 * document builder refuses a name it does not declare.
 *
 * The global security is `[]`: a route that names none is public, which is
 * what brobot's controllers are unless a guard says otherwise.
 */
import { doc, requirementsOf } from '@singularity/http-contract';
import type {
    OpenApiInfo,
    OpenApiServer,
    SecurityRequirement,
    SecuritySchemeObject,
} from '@singularity/http-contract';

export const securitySchemes = {
    cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'accessToken',
        description: doc`
            brobot's access JWT in the httpOnly \`accessToken\` cookie, set by
            the viewer login callback and by a cookie-mode refresh. Read by
            JwtAuthGuard after the bearer header.
        `,
    },
    bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: doc`
            brobot's access JWT as \`Authorization: Bearer\` (native clients,
            ngx-auth's bearer mode). JwtAuthGuard checks it before the cookie.
        `,
    },
    serviceToken: {
        type: 'http',
        scheme: 'bearer',
        description: doc`
            \`Authorization: Bearer $BROBOT_SERVICE_TOKEN\`, compared in
            constant time: api-time (and the owner) on the
            \`/internal/*\` routes. Never a user's session.
        `,
    },
} as const satisfies Record<string, SecuritySchemeObject>;

export type BrobotSecuritySchemeName = keyof typeof securitySchemes;

/** A route's security, checked against the declared schemes at compile time. */
export const requires: (...schemes: readonly BrobotSecuritySchemeName[]) => SecurityRequirement[] =
    requirementsOf(securitySchemes);

/** The global security: public, unless a route says otherwise. */
export const globalSecurity: SecurityRequirement[] = [];

/** A signed-in user, by bearer header or cookie: what JwtAuthGuard accepts. */
export const userSession: SecurityRequirement[] = requires('bearerAuth', 'cookieAuth');

export const brobotInfo: OpenApiInfo = {
    title: 'brobot API',
    description: doc`
        The HTTP API of brobot, the bro_____bot Twitch bot: Twitch sign-in
        and account links, the command switches, the Pokémon pages of the
        admin site, and the internal routes api-time and the owner call.
    `,
    version: '2.0.0',
};

export const brobotServers: OpenApiServer[] = [
    { url: '/api', description: 'API base path (the global prefix)' },
];
