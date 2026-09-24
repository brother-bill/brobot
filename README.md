# brobot

The API and Twitch bot behind **bro_____bot**. It lets a streamer's viewers
play with the stream: `!chatban` disables the streamer's Enter key,
`!voiceban` mutes their mic, and `!pokemon` lets viewers catch, level and
battle Pokémon on Pokémon Showdown's battle simulator. Soon those Pokémon
can also travel to pmd-online.

This is the 2026 rebuild of the 2022–2023 app, done in place: NestJS 11,
MikroORM + Postgres, zod-validated config and brobot's own JWTs, with no
Prisma, express-session or passport. It lives in the singularity monorepo
as `apps/brobot` (package `@singularity/brobot`). The migration charter is
`guidelines/brobot/migration-plan.md` in the superproject. This README
covers the state after ticket **B1**.

The bot itself (chat, EventSub, the `!pokemon` family, votes) arrives with
B2, and the Pokémon transfer API with B3.

## Layout

```
src/
  main.ts, bootstrap.ts     boot: env check → migrations → listen
  app.module.ts             EVERY module is registered here already; later tickets edit only their own module
  mikro-orm.config.ts       one ORM config for the app and the CLI
  config/                   zod env schema (fails at boot, names every bad variable)
  entities/                 the eight tables, one-to-one with the old Prisma schema (+ §4 transfer columns)
  migrations/               empty until the owner generates the initial migration
  common/                   CORS, constant-time compare, zod pipe
  modules/
    auth/                   the three Twitch OAuth flows, JWT, guards, the Twitch token stores
    pokemon/                read-only HTTP for the admin site
    commands/               command list + on/off switches
    twitch/                 bot shell: /api/ashketchum socket (B2 fills the module)
    transfer/               ServiceTokenGuard (B3 adds /api/internal/transfer/*)
    health/                 /api/health, /api/health/live
scripts/                    operator scripts (B3: Prisma-dump import)
deploy/                     infra templates (I1)
test/                       shared test helpers, integration global setup
```

## Running it

```bash
cp .env.example .env          # fill in the Twitch app + secrets
pnpm run db:schema:dev        # LOCAL dev database only: create/align tables from the entities
RUN_MIGRATIONS=false pnpm run dev
```

`db:schema:dev` is for a throwaway local database only. Real schema changes
go through migrations. **The owner generates them**
(`pnpm exec mikro-orm migration:create` in `apps/brobot`), and agents never
do. The initial migration does not exist yet.

At boot the app applies pending migrations before it listens
(`RUN_MIGRATIONS=false` skips that). It then serves the HTTP API on `PORT`
(default 3000) under `/api`, and the streamer socket at `/api/ashketchum`.

### Checks

```bash
pnpm exec eslint .
pnpm exec tsc --noEmit -p tsconfig.app.json
pnpm exec tsc --noEmit -p tsconfig.spec.json
pnpm run test               # unit, including a full AppModule boot with the DB switched off
pnpm run test:integration   # real Postgres via testcontainers (needs Docker)
```

## Environment

`.env.example` lists every variable. `src/config/env.schema.ts` is the
authority on what each one must look like. The app refuses to start with a
missing or malformed required variable, and it reports all of them at once.

| Required | |
|---|---|
| `DATABASE_URL` | `postgres://…` |
| `DOMAIN` | public API hostname (EventSub callback host) |
| `UI_URL` | where OAuth callbacks send the browser; its origin must be in `ALLOWED_ORIGINS` |
| `ALLOWED_ORIGINS` | comma-separated bare origins, at least one |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | ≥ 32 chars, different |
| `BROBOT_SERVICE_TOKEN` | ≥ 32 chars, shared with api-time |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | the Twitch application |
| `TWITCH_CALLBACK_URL_USER` / `_STREAMER` / `_BOT` | registered redirect URIs |
| `TWITCH_STREAMER_OAUTH_ID`, `TWITCH_BOT_OAUTH_ID` | numeric ids; the only accounts the streamer / bot flows accept |
| `TWITCH_STREAMER_CHANNEL_LISTEN`, `TWITCH_BOT_USERNAME` | channel and bot login |
| `EVENT_SUB_SECRET` | 10–100 chars |
| `WS_SECRET` | ≥ 16 chars, presented by the streamer client |

Optional: `NODE_ENV`, `PORT`, `RUN_MIGRATIONS`, and the integration keys
`RIOT_API_KEY`, `LICHESS_AUTH_TOKEN`, `OPEN_API_KEY`, `STREAMLABS_CLIENT_ID`,
`STREAMLABS_SECRET`, `STREAMLABS_REDIRECT_URI` (an unset key disables its
feature). The following are retired and no longer read: `SESSION_SECRET` and
the `AWS_*` deploy variables.

## Auth model

There are three Twitch OAuth code flows, because the scopes differ. They
share one brobot session.

| Flow | Start | Accepts | Result |
|---|---|---|---|
| viewer | `GET /api/auth/twitch/login` | any Twitch account | upserts `twitch_user` + `twitch_user_registered`, issues brobot's JWT pair |
| streamer | `GET /api/auth/twitch/streamer` | only `TWITCH_STREAMER_OAUTH_ID` | stores the token in `twitch_streamer_auth`, grants role `StreamerAuth` |
| bot | `GET /api/auth/twitch/bot` | only `TWITCH_BOT_OAUTH_ID` | stores the token in `twitch_bot_auth`, grants role `BotAuth` |

- The streamer and bot flows **never touch the browser's session**. Linking
  the bot while signed in as the streamer leaves you signed in as the
  streamer.
- Every flow uses a single-use `state` cookie (CSRF). The streamer and bot
  flows force Twitch's account picker (`force_verify`).
- The session is a JWT pair, the same shape api-time issues, so
  `libs/ngx-auth` works unchanged. The access token lasts 15 min and the
  refresh token 7 days. Both are httpOnly, `Secure`, `SameSite=Strict`
  host-only cookies named `accessToken` and `refreshToken`. An
  `Authorization: Bearer` header is also accepted and is checked first.
- **Roles** live in `twitch_user.roles` and are re-read on every request.
  Admin endpoints need `StreamerAuth` (granted only to the configured
  streamer) or `Admin` (granted by hand, e.g. to moderators). `BotAuth` is
  not an admin role.
- B2 gets Twitch credentials from
  `TwitchTokenStoreService.createAuthProvider('bot' | 'streamer')`: a Twurple
  `RefreshingAuthProvider` that writes each refresh back to the same table.

## HTTP surface (for the admin site, U1)

Everything is under `/api`. JSON bodies use camelCase. Errors are Nest's
standard `{ statusCode, message, error }`; zod validation failures (400) add
`issues: [{ path, message }]`.

### Health: public, no database, not rate-limited

| Route | Response |
|---|---|
| `GET /api/health/live` | `{ status: 'live', pid: number, uptime: number }` |
| `GET /api/health` | `{ status: 'ok', service: 'brobot', uptime: number, build: { sha: string, time: string } }` |

### Auth: `/api/auth/twitch`

| Route | Behaviour |
|---|---|
| `GET login` · `GET streamer` · `GET bot` | 302 to Twitch, and sets the flow's state cookie. The UI navigates here (a full page load, not XHR). |
| `GET callback` | Viewer login. Sets the `accessToken` and `refreshToken` cookies, then 302s to `UI_URL`. A client sending `Accept: application/json` gets `200 { accessToken, refreshToken }` instead. |
| `GET streamer/callback` · `GET bot/callback` | Stores the token, then 302s to `UI_URL?linked=streamer` or `?linked=bot`. With JSON: `200 { linked }`. Session cookies are left untouched. |
| Any callback failure | 302 to `UI_URL?auth_error=<reason>`, where reason is `access_denied` (the user declined), `invalid_state` (stale or forged callback, or a reused code: just start again), `wrong_account` (streamer/bot flow completed with another account) or `twitch_unavailable`. With JSON: 401 / 403 / 502. |
| `GET status` (JWT) | `{ oauthId, displayName, roles: string[], profileImageUrl: string \| null, scope: string[] }`, or 401 |
| `POST refresh` | Body `{ refreshToken }` (bearer mode) → `200 { accessToken, refreshToken }`. No body (cookie mode) → new cookies and an empty `200`. Invalid → 401 and the cookies are cleared. |
| `POST /api/auth/refresh` | Alias of the above. ngx-auth's interceptor skips its 401 retry only for URLs containing `/auth/refresh`. |
| `POST logout` | 204; clears both cookies (stateless: an issued access token lives out its 15 min) |

### Pokémon: public reads

| Route | Response |
|---|---|
| `GET /api/pokemon/leaderboard` | Top 30 by level: `[{ level, name, nameId, shiny, activeGame: 'brobot' \| 'pmd', twitchUser: { displayName } }]` |
| `GET /api/pokemon/teams?login=<twitch login>` | `{ displayName, pokemonTeam: { pokemon: TeamPokemon[] } \| null }`, sorted by slot. 400 if the login is not `[A-Za-z0-9_]{1,25}`; 404 if brobot has never seen that user; 502 if Twitch is down. **Rate-limited to 10/min per client; each login's answer is cached for 60 s.** |
| `GET /api/pokemon/battle-outcome` | Last `!pokemon battle`: `{ outcome: string[], updatedDate: string \| null }` |
| `GET /api/pokemon/team-battle-outcome` | Last `!pokemon teambattle`, same shape |

`TeamPokemon` is `{ name, nameId, slot, level, shiny, wins, losses, draws,
item, moves: string[], dexNum, color, types: string[], gender, nature,
ability, activeGame, createdDate, updatedDate }`. It carries no ids.
`activeGame: 'pmd'` means the Pokémon is away in pmd-online; show it as
such.

### Commands

| Route | Response |
|---|---|
| `GET /api/commands` (public) | `[{ name, trigger, aliases: string[], category: 'pokemon' \| 'voting' \| 'fun' \| 'ai', description, enabled: boolean }]` |
| `POST /api/commands` (admin) | Body `{ name, enabled: boolean }` → the updated command. 401 when signed out, 403 when not admin, 404 for an unknown name. |

Switches are held in memory and reset to their defaults on restart. `quack`
starts off, and a channel-point redeem turns it on.

### Everything else

- **Rate limit:** 120 requests/min per client on every route except health.
  Over the limit returns `429`.
- **CORS:** only `ALLOWED_ORIGINS`, with credentials.
- **`/api/ashketchum`** (WebSocket, streamer client): the upgrade needs the
  `WS_SECRET`, sent either as a `token` header (2022 client) or as
  `Authorization: Bearer`. Otherwise the upgrade is refused with 401 before a
  socket exists. No events yet (B2).
- **`/api/internal/transfer/*`** (B3): `Authorization: Bearer
  $BROBOT_SERVICE_TOKEN`, checked by `ServiceTokenGuard`.

## Credits

brobot leans on [Twurple](https://github.com/twurple/twurple) for everything
Twitch, and on [Pokémon Showdown](https://github.com/smogon/pokemon-showdown)
(via `@pkmn`) for battles.
