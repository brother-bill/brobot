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
covers the state after tickets **B1** (the API), **B2** (the bot) and **B3**
(the Pokémon transfer API and the import of the old database).

## Layout

```
src/
  main.ts, bootstrap.ts     boot: env check → migrations → listen
  app.module.ts             EVERY module is registered here already; later tickets edit only their own module
  mikro-orm.config.ts       one ORM config for the app and the CLI
  config/                   zod env schema (fails at boot, names every bad variable)
  entities/                 the eight old tables, one-to-one with the Prisma schema (+ §4 transfer columns), and command_setting
  migrations/               empty until the owner generates the initial migration
  common/                   CORS, constant-time compare, zod pipe
  modules/
    auth/                   the three Twitch OAuth flows, JWT, guards, the Twitch token stores
    pokemon/                read-only HTTP for the admin site, and the game: generation, team rules, exclusivity, battles
    commands/               command list, chat-command parser, stored on/off switches
    twitch/                 the bot: chat, EventSub, !pokemon, drops, redeems, votes, the two sockets
    transfer/               /api/internal/transfer/* for api-time, the active_game state machine,
                            transfer_log (entities/), and the Prisma-dump import's mappers (import/)
    health/                 /api/health, /api/health/live
scripts/                    operator scripts: import-prisma-dump.ts
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
feature; `!chess` works without a Lichess token, and nothing reads the
Streamlabs or Riot keys yet).

| Bot switches (optional) | |
|---|---|
| `TWITCH_BOT_ENABLED` | default `true`. `false` keeps chat, drops and reward handling offline; the API and sockets still serve. |
| `TWITCH_EVENTSUB_ENABLED` | default `false`. `true` (production, with `TWITCH_BOT_ENABLED`) mounts the EventSub webhook at `https://$DOMAIN/twitch/…` and subscribes to redemptions and raids. nginx must pass `/twitch/` to the API. |
| `OPENAI_MODEL` | default `gpt-4o-mini`; the model behind the `@bro_____bot` reply. | The following are retired and no longer read: `SESSION_SECRET` and
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
- The bot gets Twitch credentials from
  `TwitchTokenStoreService.createAuthProvider('bot' | 'streamer')`: a Twurple
  `RefreshingAuthProvider` that writes each refresh back to the same table.
  Until the bot and streamer flows have been completed once, chat and the
  reward handling log a warning and stay offline.

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

A switch that has been flipped is stored in `command_setting` and survives a
restart; the others run on their catalog default. `quack` starts off, and the
`Enable Quacks` channel-point redeem turns it on. A switched-off command is
ignored in chat, except the votes, which answer `!chatban is turned off`.

### Everything else

- **Rate limit:** 120 requests/min per client on every route except health.
  Over the limit returns `429`.
- **CORS:** only `ALLOWED_ORIGINS`, with credentials.
- **`/api/ashketchum`** (WebSocket, streamer client): the upgrade needs the
  `WS_SECRET`, sent either as a `token` header (2022 client) or as
  `Authorization: Bearer`. Otherwise the upgrade is refused with 401 before a
  socket exists. The frames are JSON `{ type, … }`, defined in
  `src/modules/twitch/streamer-events.ts` — the file the streamer client
  (C1) copies. brobot sends `chatban` / `voiceban` (with `durationMs`) and a
  `ping` every 15 s; the client sends `chatban_complete` /
  `voiceban_complete` (optional `error`) when the ban is over, and may answer
  `pong`.
- **`/api/admin-ui`** (WebSocket, stream overlay): no secret, receive-only.
  brobot sends `pokemon_roar` and `quack` frames
  (`src/modules/twitch/overlay-events.ts`).
- **`/api/internal/transfer/*`**: see the next section.

## Internal transfer API (for api-time)

This is how a Pokémon moves between brobot and pmd-online (migration plan
§4). **api-time is the only caller.** It proves that the player owns the
Twitch account, then calls brobot with that Twitch id. brobot checks that
the row belongs to that Twitch id and flips `active_game`. The shapes are
mirrored in the superproject at `libs/pmd-contracts/src/transfer.ts`
(`BrobotPokemonSchema` and the request schemas, ticket A1). Change both
together.

- **Auth:** `Authorization: Bearer $BROBOT_SERVICE_TOKEN` on every route.
  Anything else gets 401. These routes are not rate-limited, because every
  player's request comes from the one api-time host.
- **Errors** are `{ statusCode, error, code, message }`:

| Status | `code` | When |
|---|---|---|
| 400 | (none; `issues` as elsewhere) | malformed id, Twitch id, body |
| 403 | `pokemon_not_owned` | the row belongs to another Twitch user |
| 404 | `pokemon_not_found` | no Pokémon with that id |
| 409 | `pokemon_away` | depart: already in PMD under a **different** register row |
| 409 | `pokemon_not_away` | return: already in brobot, and the request does not name the register row it came back from |
| 409 | `register_mismatch` | return: in PMD under a different register row than the one named |
| 409 | `nonce_reused` | the nonce belongs to an earlier transition of this Pokémon, not its last one |

### `TransferPokemon`

```ts
{
  id: string;                 // brobot row uuid: the Pokémon's identity forever (PMD originKey)
  nameId: string;             // @pkmn species id, e.g. "pikachu"
  dexNum: number;
  name: string;               // e.g. "Pikachu"
  level: number;              // unbounded in brobot
  shiny: boolean;
  gender: 'M' | 'F' | 'N';
  nature: string;
  ability: string;
  item: string;               // '' = no item
  moves: string[];            // @pkmn move ids, verbatim
  types: string[];
  wins: number; losses: number; draws: number;
  activeGame: 'brobot' | 'pmd';
  pmdRegisterId: string | null;    // kept after return, for the next trip
  levelAtDeparture: number | null; // brobot level when it last left; null if it never has
  createdDate: string;        // ISO 8601
}
```

### Routes

| Route | Body | 200 response |
|---|---|---|
| `GET /api/internal/transfer/users/:twitchId/pokemon` | none | `{ pokemon: TransferPokemon[] }`: every Pokémon of that Twitch user, in either game, oldest first. An unknown Twitch id gets `{ pokemon: [] }`. |
| `GET /api/internal/transfer/pokemon?twitchId=` | none | the same |
| `POST /api/internal/transfer/pokemon/:id/depart` | `{ twitchId, pmdRegisterId: uuid, nonce }` | `{ pokemon: TransferPokemon }` |
| `POST /api/internal/transfer/pokemon/:id/return` | `{ twitchId, pmdLevel: 1..100, nonce, pmdRegisterId?: uuid }` (`level` is accepted in place of `pmdLevel`) | `{ pokemon: TransferPokemon }` |

`twitchId` is a numeric string. `nonce` is 1–128 characters, and api-time
sends its `Idempotency-Key` uuid.

**depart** (brobot → PMD) moves only a Pokémon whose `activeGame` is
`brobot`. It sets `activeGame = 'pmd'`, `levelAtDeparture = level`,
`pmdRegisterId`, and `pmd_first_transferred_at` if that is still null.
`level` does not change: PMD applies its own cap of 100.

**return** (PMD → brobot) moves only a Pokémon whose `activeGame` is `pmd`.
It sets `activeGame = 'brobot'` and
`level = max(level, levelAtDeparture ?? level, pmdLevel)`. **A level never
goes down.** A level-150 Pokémon that visited PMD as 100 comes back as 150.
A level-40 Pokémon that PMD raised to 55 comes back as 55. `pmdRegisterId`
and `levelAtDeparture` are kept.

**Idempotency.** Each transition writes a `transfer_log` row in the same
transaction as the flip. That row holds the pokemon id, direction, nonce,
Twitch id, register id, the level before and after, and the time. The
Pokémon's row is locked for the duration, so concurrent calls run one at a
time.

- Repeating the nonce of the Pokémon's **last** transition returns the row
  as it stands and writes nothing.
- A depart with a new nonce while the Pokémon is already in PMD **under the
  same `pmdRegisterId`** also answers 200 without writing. The same goes for
  a return with a new nonce while the Pokémon is already home and the
  request names the register row it came back from. api-time depends on
  this: when its own transaction rolls back after brobot has committed, it
  retries with a new nonce. Any other new nonce is a 409.
- A request that moves nothing writes no `transfer_log` row. The table is
  exactly the Pokémon's travel history.

## Importing the old database

`scripts/import-prisma-dump.ts` loads the old Prisma database (the RDS
`brobot-api-prod`) into the new schema through MikroORM. It covers
`TwitchUser` (with `roles[]` kept), `TwitchUserRegistered`,
`TwitchBotAuth`, `TwitchStreamerAuth`, `PokemonTeam`, `Pokemon` (every
Pokémon arrives with `active_game = 'brobot'`) and both battle-outcome
tables. `Session` is not imported.

```bash
# 1. a plain, data-only dump of the old database (the default COPY format; not --inserts, not -Fc)
pg_dump --data-only --format=plain "$OLD_URL" > brobot-prisma.sql

# 2. map every row; counts per table, every row that cannot be mapped. Connects to nothing.
pnpm run import:prisma-dump -- brobot-prisma.sql --dry-run

# 3. write it (one transaction; the new schema must already exist)
DATABASE_URL=postgres://…new… pnpm run import:prisma-dump -- brobot-prisma.sql

# or read the old database directly instead of a dump
DATABASE_URL_OLD=postgres://…old… DATABASE_URL=postgres://…new… pnpm run import:prisma-dump -- --from-db
```

- **Idempotent.** Rows are upserted on the old primary keys, so running the
  same dump twice changes nothing. A Pokémon's transfer columns
  (`active_game`, `pmd_register_id`, `pmd_first_transferred_at`,
  `level_at_departure`) are never overwritten. Everything else is taken
  from the dump, so do not re-import after the new bot has gone live.
- **Stops at the first row it cannot map** and exits 1, printing the table,
  the row number, the old id, the column and the reason. Nothing is written.
  With `--continue`, it skips such rows instead, together with the rows that
  depend on them (a skipped user's team, tokens and Pokémon), lists every
  one, and imports the rest.
- **Refuses** what the new schema or the transfer contract cannot hold: a
  slot outside 1–6, a level below 1, negative win/loss/draw counts, a gender
  other than `M`/`F`/`N`, an id that is not a uuid, a NULL array element.
  NULL `text[]` columns become `{}`, except `roles`, which gets its default
  `{Viewer}`.
- **Warns** about two Pokémon in the same team slot. The old bot allowed it,
  and so does the new schema.
- After writing, it prints the row count of each new table, to compare
  against the old database (runbook §6 step 3).
- Exit codes: `0` done, `1` a row could not be mapped (without
  `--continue`), `2` bad arguments, an unusable dump, or a database error.

## The bot

The chat copy is the old bot's, word for word, except where a rule below
is new.

| In chat | What happens |
|---|---|
| `!pokemon` | link to the commands page |
| `!pokemon team` | link to the team page, then the team: `1. Lv 12 Pikachu · 2. Lv 40 Eevee (away in PMD)` |
| `!pokemon battle` | challenge with your slot-1 starter; the next viewer to type it within a minute accepts. The winner gains a level unless it is more than 20 levels above the loser; wins, losses and draws are recorded, and the log is saved for `GET /api/pokemon/battle-outcome` |
| `!pokemon teambattle` | the same with every Pokémon on each team; wins and losses for all, no levels |
| `!pokemon catch` | during a drop: a coin flip per throw, three throws, one catch per viewer, into the lowest free slot |
| `!pokemon delete\|remove <slot>` | delete it; six a day per viewer, reset at midnight New York time |
| `!pokemon swap\|switch <a> <b>` | swap two slots; the Pokémon keep their ids |
| `!pokemon create <user> <pokemon> <level> <shiny 0\|1>` | broadcaster, or a user with the `Admin` role, adds a Pokémon for someone |
| `!chatban`, `!voiceban` | four distinct viewers → the streamer client blocks Enter for 5 min / mutes the mic for 30 s |
| `!chess`, `!rps`, `!dice`, `!ping`, `!commands`, `!quack` | as before |
| `@bro_____bot …` | an OpenAI reply in the old persona, six an hour, only while the streamer client is connected |

Every 30 minutes a wild level-1 Pokémon from the drop dex appears for two
minutes (1 in 8 shiny). Channel-point rewards, received over EventSub:
`Pokemon Create` (a random generation-1–4 Pokémon in the slot typed,
replacing what is there), `Pokemon Level Up` (+1 for the starter),
`Pokemon Roar` (the starter appears on the overlay) and `Enable Quacks`. A
redeem that cannot be honoured is refunded. brobot pauses its rewards when
it shuts down and resumes them when it starts. Raids get a shout-out.

**A Pokémon away in pmd-online** (`active_game = 'pmd'`, migration plan §4)
is read-only here: it cannot battle, be swapped, deleted or replaced, level
up or roar, and it still holds its slot. `!pokemon team` shows it as "away in
PMD". A team battle fields the rest of the team.

## Credits

brobot leans on [Twurple](https://github.com/twurple/twurple) for everything
Twitch, and on [Pokémon Showdown](https://github.com/smogon/pokemon-showdown)
(via `@pkmn`) for battles.
