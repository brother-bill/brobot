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
  http/                     the whole HTTP surface as zod route definitions (@singularity/http-contract),
                            and brobotDocument(), its OpenAPI 3.1 document (committed as openapi.json)
  modules/
    auth/                   the three Twitch OAuth flows, JWT, guards, the Twitch token stores
    pokemon/                read-only HTTP for the admin site, and the game: generation, team rules, exclusivity, battles
    commands/               command list, chat-command parser, stored on/off switches
    twitch/                 the bot: chat, EventSub, !pokemon, drops, redeems, votes, the two sockets,
                            the Discord go-live post and schedule sync
    transfer/               /api/internal/transfer/* for api-time, the active_game state machine,
                            transfer_log (entities/), and the Prisma-dump import's mappers (import/)
    health/                 /api/health, /api/health/live
scripts/                    operator scripts (import-prisma-dump.ts) and the openapi / env:schema exports
openapi.json                the HTTP contract, generated: `pnpm run openapi`
served-routes.json          what Nest serves, as served-routes/v1, generated: `pnpm run served-routes`
contract-lint-ignore.txt    its lint exceptions under singularity's ruleset: `pnpm run contract:lint`
deploy/                     where the deploy lives (it is not here); github/ stages this repo's CI
test/                       shared test helpers, integration global setup
```

## Running it

```bash
cp .env.example .env          # fill in the Twitch app + secrets
pnpm run db:schema:dev        # LOCAL dev database only: create/align tables from the entities
RUN_MIGRATIONS=false pnpm run dev
```

`nest build` and `nest start` compile against `@singularity/http-contract`'s
built `dist/` (`tsconfig.build.json`), and the build refuses a missing or
stale one with the recovery command. Build it, from the superproject root,
with `pnpm exec turbo run build --filter=@singularity/brobot`. The typecheck,
lint and tests read the library's source and need no build.

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
pnpm run contract:lint      # openapi.json under singularity's contract ruleset (from the superproject)
pnpm run served-routes      # rewrite served-routes.json after a route change (the parity spec checks it)
```

## Environment

`.env.example` lists every variable. `src/config/env.schema.ts` is the
authority on what each one must look like. The app refuses to start with a
missing or malformed required variable, and it reports all of them at once.

Each key also has a config-store kind (`bootstrap`, `secret`, `plain`,
`topology`), exported to `env.schema.json` by `pnpm run env:schema`. How prod
and dev config are imported into the store, and how to fetch dev config with
`pnpm run config:pull-dev`, is in `CLAUDE.md`.

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

| Discord (optional) | |
|---|---|
| `DISCORD_BOT_URL` | the discord-bot's origin, without `/api` (in-cluster `http://discord-bot.discord.svc.cluster.local`). Unset: going live is not announced, and the schedule is not synced. |
| `DISCORD_INTERNAL_API_TOKEN` | the bot's `INTERNAL_API_TOKEN`, ≥ 32 chars; required with `DISCORD_BOT_URL`, and refused without it |
| `DISCORD_ANNOUNCE_SERVER` | default `home`: the bot's `servers/<slug>.yaml` the announcement and the scheduled events go to |

When the streamer goes live (EventSub `stream.online`, live broadcasts only,
so not a rerun or premiere), brobot posts one announcement per broadcast to
the discord-bot's `POST /api/internal/announce`: `project: brobot`,
`kind: stream-live`, the stream's title and category (from Helix), Twitch's
preview image, the channel link and `ping: none`: it pings nobody, since
Discord announcements never ping by default (owner, 2026-10-19). The bot's
server file (`announce.projects.brobot.kinds.stream-live`) picks the channel;
brobot never names one. A 5xx or an unreachable bot is retried for about four
minutes with the same idempotency key, so it posts once; a 4xx (an unrouted
kind, a missing channel) is logged and not retried.
When the stream ends (`stream.offline`), brobot edits that post through
`POST /api/internal/announce/edit`, addressed by the same idempotency key:
"was live" in the title, what was streamed and for how long, a link to the
past broadcasts, no preview image, and `Was live` in the footer. What is on
air is held in memory; at startup brobot asks Helix whether the stream is
already live, so a deploy mid-stream still marks its end. The bot remembers
a key for 24 hours and not across its own restart; a post it has forgotten
(`404 unknown_post`) is logged and left as it is. The code is
`src/modules/twitch/go-live/`. Turning it on (the bot's route, the
env, the chart allowlist) and what is not built yet: the superproject's
`guidelines/discord/twitch.md`.

The streamer's Twitch schedule is mirrored into Discord Scheduled Events
through `POST /api/internal/announce/events`, with the same env. brobot
reads the schedule with the app token (Helix `GET /schedule`, no streamer
grant) and lists the segments that start within the next 7 days and have
not ended, skipping cancelled ones and those inside a vacation, at most 25.
Each becomes an event keyed `twitch:segment:<id>`: named after the
segment's title, else its category, else `<name> on Twitch` (≤ 100
characters), described by the category and the channel link (≤ 900), at
`https://twitch.tv/<login>`, with the category's box art as the cover, and
ending four hours after the start when Twitch gives no end. One request
carries the whole list for `source: twitch:<broadcaster id>`; the bot
creates, updates and deletes its events of that source to match. A
broadcaster with no schedule (Helix 404) sends an empty list, which deletes
them; any other Helix failure sends nothing, since an empty list would
delete every event. It syncs at startup, every 15 minutes, and on EventSub
`channel.update` (subscribed beside `stream.online` when EventSub is on).
Overlapping triggers run as one sync, with at most one queued behind it.
A 5xx or an unreachable bot is retried as the go-live post is; a 4xx is
logged and not retried: `422 no_route` means the bot's server file has not
switched events on for brobot, and a `404` that names no server or project
means the bot has not deployed the endpoint yet. Off with
`TWITCH_BOT_ENABLED=false`, as the rest of the bot. The code is
`src/modules/twitch/schedule/`.

| Bot switches (optional) | |
|---|---|
| `TWITCH_BOT_ENABLED` | default `true`. `false` keeps chat, drops and reward handling offline; the API and sockets still serve. |
| `TWITCH_EVENTSUB_ENABLED` | default `false`. `true` (production, with `TWITCH_BOT_ENABLED`) mounts the EventSub webhook at `https://$DOMAIN/twitch/…` and subscribes to redemptions and raids, and to the stream going live and ending and the channel's title or category changing when `DISCORD_BOT_URL` is set. nginx must pass `/twitch/` to the API. |
| `OPENAI_MODEL` | default `gpt-4o-mini`; the model behind the `@bro_____bot` reply. |
| `TWITCH_PREDICTION_TITLE` | default `Will Trama Win This Game?`, ≤ 45 chars: the streamer client's `create_prediction` hotkey. |
| `TWITCH_PREDICTION_OUTCOMES` | default `Yes,No`: comma-separated, 2–10, each ≤ 25 chars. |
| `TWITCH_PREDICTION_WINDOW_SECONDS` | default `90` (30–1800): seconds before Twitch locks the prediction. |

The following are retired and no longer read: `SESSION_SECRET` and
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

Everything is under `/api`. **The contract is [`openapi.json`](openapi.json)**:
OpenAPI 3.1, every operation (24) with its parameters, bodies, responses,
statuses and security. It is generated from `src/http/` by `pnpm run openapi`
and committed; `src/http/openapi-document.spec.ts` fails when it is stale. Read
it, or load it into any OpenAPI viewer, rather than a table here.

It is registered in singularity's contract registry
(`libs/contracts/documents.yaml`, name `brobot`) and held to singularity's
lint ruleset: `pnpm run contract:lint` runs the same lint step as
singularity's `contract-check.yml`. The only exceptions are in
[`contract-lint-ignore.txt`](contract-lint-ignore.txt), each with its reason:
the three Twitch start routes answer only 302, and the probes never answer a
4xx. Everything else the lint reports is fixed in `src/http/`.

`src/http/` holds one `defineRoute` per operation, with every request and
response as a zod schema whose component id starts with `Brobot`. Each
controller validates with its route's slots
(`new ZodValidationPipe(routes.getTeam.query)`) and returns
`RouteResult<typeof routes.getTeam>`, so a handler that answers anything else
does not compile. `brobotDocument()` builds the document, and
`src/http/document.spec.ts` holds it equal to what Nest serves: the same
operations at the same statuses. A route change is made there first.

`src/http/served-routes.spec.ts` holds the document to singularity's contract
checks (`libs/contracts/docs/publishing-a-contract.md`). It boots the real
`AppModule` (database and Twitch faked), reads what Nest serves into
`served-routes/v1` (`src/http/served-routes.ts`: query and path names from
each `ZodValidationPipe`'s schema), and runs the shared checker
(`libs/contracts/scripts/served-routes-check.mjs`) against `openapi.json`,
failing on any finding. It then validates every response it gets, success and
error, against the document's schema for that status (Ajv 2020), calling each
operation at least once. Metadata cannot see what a handler or its service
throws, or what it reads through `@Req()`; those are the spec's `HANDLERS`
table, so a handler that starts answering a new status is listed there (the
spec fails on an answered status the table does not list). The EventSub
webhook and the two sockets are pinned there as outside the document, each
with its reason.

The served routes are committed as [`served-routes.json`](served-routes.json)
(routes sorted by path, then method), and the spec fails when the file is not
what Nest serves: after a route change, run `pnpm run served-routes` (the spec
with `BROBOT_WRITE_SERVED_ROUTES=1`, which writes the file before comparing)
and commit the result. The file is what CI checks: `.github/workflows/contract.yml`
(staged as [`deploy/github/contract.yml`](deploy/github/contract.yml) until it
is installed) calls singularity's `contract-check.yml` on a pull request that
touches `openapi.json`, `served-routes.json`, `contract-lint-ignore.txt` or
`src/http/`, with the lint exceptions read from `contract-lint-ignore.txt`.
Committed rather than uploaded because brobot's tests run only inside the
superproject (its workspace libraries), never in this repository's CI.

What the document does not say:

- **Errors** are Nest's standard `{ statusCode, message, error }` (`error` is
  absent when the exception carries no message:
  `{ statusCode: 401, message: 'Unauthorized' }`); zod validation failures
  (400) are `{ message: 'Validation failed', issues: [{ path, message }] }`.
- **Sign-in is a page load.** The UI navigates to `GET /api/auth/twitch/login`
  (or `streamer`, `bot`), not XHR: each answers 302 to Twitch and sets the
  flow's single-use state cookie.
- **Cookies.** The viewer callback sets the `accessToken` and `refreshToken`
  cookies (see "Auth model") and 302s to `UI_URL`; a client sending
  `Accept: application/json` gets the token pair in the body instead. The
  streamer and bot callbacks leave the session cookies untouched and 302 to
  `UI_URL?linked=streamer` or `?linked=bot`. A failed callback 302s to
  `UI_URL?auth_error=<reason>` (`access_denied`, `invalid_state`: just start
  again, `wrong_account`, `twitch_unavailable`). `POST /api/auth/twitch/refresh`
  takes `{ refreshToken }` in bearer mode and answers with a new pair, or no
  body in cookie mode and answers with new cookies; an invalid token is a 401
  that clears both cookies. `POST /api/auth/refresh` is its alias, because
  ngx-auth's interceptor skips its 401 retry only for URLs containing
  `/auth/refresh`. `POST /api/auth/twitch/logout` clears both cookies; it is
  stateless, so an issued access token lives out its 15 min.
- **`GET /api/pokemon/teams`** is rate-limited to 10/min per client, and each
  login's answer is cached for 60 s. A Pokémon with `activeGame: 'pmd'` is
  away in pmd-online; show it as such. It holds no slot (`slot: null`), so it
  is still on the team page and the leaderboard, but not in a numbered slot.
- **Command switches.** A switch that has been flipped (`POST /api/commands`)
  is stored in `command_setting` and survives a restart; the others run on
  their catalog default. `quack` starts off, and the `Enable Quacks`
  channel-point redeem turns it on. A switched-off command is ignored in chat,
  except the votes, which answer `!chatban is turned off`.

### Outside OpenAPI

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

  brobot also sends `{ type: 'overlay_status', connected }`, the number of
  stream overlays on `/api/admin-ui`: to each client as it connects, and to
  every client whenever an overlay connects or goes away. A client connected
  here says nothing about the overlay: roars, DEBS alerts and quacks go to
  that other socket, and with no overlay every Pokemon Roar and DEBS Alert is
  refunded ("streamer not connected to browser source").

  The streamer's hotkeys, as in the 2022 app: the client sends a bare
  `{ type }`, brobot makes one Helix call with the streamer's token, then
  answers **that client only** with `{ type: '<hotkey>_complete', error? }`.
  No `error` means Twitch did it. Code: `src/modules/twitch/hotkeys/`.

  | Client sends | Helix call (streamer channel) | Scope |
  |---|---|---|
  | `create_marker` | create a stream marker, empty description | `channel:manage:broadcast` |
  | `create_prediction` | create a prediction: `TWITCH_PREDICTION_TITLE` (default "Will Trama Win This Game?"), `TWITCH_PREDICTION_OUTCOMES` (default Yes / No), locked after `TWITCH_PREDICTION_WINDOW_SECONDS` (default 90) | `channel:manage:predictions` |
  | `play_ad` | start a 30 s commercial | `channel:edit:commercial` |

  Each hotkey runs at most once per 5 s (`HOTKEY_REPEAT_MS`), counted from the
  press that ran, whether it worked or not. A repeat inside that window makes
  no call and is answered with `error: 'ignored: <hotkey> already ran less
  than 5 s ago'`. Each press, its result and every ignored repeat are logged.
  The `error` lines the client can get:

  | `error` | Why |
  |---|---|
  | `not live` | the channel is offline (marker, commercial) |
  | `a prediction is already running` | Twitch allows one at a time |
  | `a commercial ran too recently (Twitch's cooldown)` | Helix 429 on the commercial |
  | `missing scope <scope>: link the streamer account again` | the stored streamer token lacks the scope: run `GET /api/auth/twitch/streamer` again |
  | `Twitch refused the streamer token: link the streamer account again` | any other 401 |
  | `the streamer account is not linked, or the bot is switched off` | no streamer API client (no stored token, or `TWITCH_BOT_ENABLED=false`) |
  | `Twitch said <status>: <message>` | anything else Helix refused, its own message (≤ 160 chars) |

  `channel:edit:commercial` is new on the streamer flow (the 2022 app ran the
  ad as the bot, through chat's retired `/commercial`). A streamer token
  linked before it was added answers `play_ad` with the missing-scope line
  until the streamer flow is completed again.
- **`/api/admin-ui`** (WebSocket, stream overlay): no secret, receive-only.
  brobot sends `pokemon_roar`, `debs_alert` and `quack` frames
  (`src/modules/twitch/overlay-events.ts`). `debs_alert` is
  `{ login, displayName, message }`, with `message` already censored
  (`@2toad/profanity`), trimmed, on one line and at most 500 characters. The
  2022 overlay answered `debs_alert_complete` to refund past five queued
  alerts; now brobot keeps the limit itself (five per rolling minute, across
  all viewers). Its connection count is relayed to the streamer client as
  `overlay_status` (above).
- **`/api/internal/transfer/*`**: see the next section.

## Internal transfer API (for api-time)

This is how a Pokémon moves between brobot and pmd-online (migration plan
§4). **api-time is the only caller.** It proves that the player owns the
Twitch account, then calls brobot with that Twitch id. brobot checks that
the row belongs to that Twitch id and flips `active_game`. The shapes are
mirrored in the superproject at `libs/pmd-contracts/src/transfer.ts`
(`BrobotPokemonSchema` and the request schemas, ticket A1). Change both
together: `src/modules/transfer/transfer-wire.spec.ts` fails when they drift
(a body pmd-contracts accepts that the route refuses or strips, a path
api-time builds that is not the route's, an answer api-time would reject).
Its `KNOWN_GAPS` are the bodies pmd-contracts accepts and brobot still
refuses. `@singularity/pmd-contracts` is a devDependency, for that spec only,
so the image does not carry it; `tsconfig.build.json` maps it to source so
the build never asks for its `dist/`.

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
| 409 | `not_forward_evolution` | return: `species` is not a forward evolution of the row's species |
| 409 | `unknown_move` | return: a `moves` id that `@pkmn` does not know |
| 409 | `team_full` | return: all six brobot slots are taken. Message: `your brobot team is full: free a slot with !pokemon delete <n> first` |

api-time turns any 409 into `brobot_refused` carrying brobot's `message`.
pmd-online does not show that message yet: it answers every `brobot_refused`
with its own generic refusal line (`transfer.refusal.refused`).

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

The shapes below are a reading aid; `openapi.json` (tag `Transfer`) is the
contract.

| Route | Body | 200 response |
|---|---|---|
| `GET /api/internal/transfer/users/:twitchId/pokemon` | none | `{ pokemon: TransferPokemon[] }`: every Pokémon of that Twitch user, in either game, oldest first. An unknown Twitch id gets `{ pokemon: [] }`. |
| `GET /api/internal/transfer/pokemon?twitchId=` | none | the same |
| `POST /api/internal/transfer/pokemon/:id/depart` | `{ twitchId, pmdRegisterId: uuid, nonce }` | `{ pokemon: TransferPokemon }` |
| `POST /api/internal/transfer/pokemon/:id/return` | `{ twitchId, pmdLevel: 1..100, nonce, pmdRegisterId?: uuid, species?: { nameId, name, dexNum }, moves?: string[1..4] }` (`level` is accepted in place of `pmdLevel`) | `{ pokemon: TransferPokemon }` |

`twitchId` is a numeric string. `nonce` is 1–128 characters, and api-time
sends its `Idempotency-Key` uuid.

**depart** (brobot → PMD) moves only a Pokémon whose `activeGame` is
`brobot`. It sets `activeGame = 'pmd'`, `levelAtDeparture = level`,
`pmdRegisterId`, and `pmd_first_transferred_at` if that is still null.
`level` does not change: PMD applies its own cap of 100. It also gives up
its team slot (`slot = null`): an away Pokémon holds none, so the viewer's
slot 1 is free for a catch or a swap and Roar and battles keep working.

**return** (PMD → brobot) moves only a Pokémon whose `activeGame` is `pmd`.
It sets `activeGame = 'brobot'`, the lowest free slot of the viewer's team
(slot 1 when free, as a catch does; read under the team's lock, so a catch
cannot take the same slot meanwhile), and
`level = max(level, levelAtDeparture ?? level, pmdLevel)`. With all six
slots taken it is a 409 `team_full` and nothing moves. **A level never
goes down.** A level-150 Pokémon that visited PMD as 100 comes back as 150.
A level-40 Pokémon that PMD raised to 55 comes back as 55. `pmdRegisterId`
and `levelAtDeparture` are kept.

What changed while it was away (in PMD, or in Minecraft through PMD, the
hub) comes home with it. Each part applies only when the body carries it,
so a body with neither changes nothing else:

- `species`: an evolution. It applies only when `species.nameId` is a forward
  evolution of the row's species along `@pkmn`'s `prevo` chain (Pichu →
  Raichu and Eevee → Sylveon pass; Raichu → Pikachu does not).
  `name_id`, `name`, `dex_num`, `types` and `color` are then recomputed from
  `@pkmn`'s generation-4 dex, the one rows are created from. The body's `name`
  and `dexNum` are validated but not used. Sending the row's own species
  changes nothing. Anything else is a 409 `not_forward_evolution` and nothing
  moves. Shiny, gender, nature, ability and item are kept.
- `moves`: the moveset, replaced verbatim once every id is a known `@pkmn`
  move. Otherwise it is a 409 `unknown_move` and nothing moves.

These apply only on the transition itself. A replay or a Pokémon already home
applies nothing.

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
- **Refuses** a second Pokémon in a team slot (`slot: team … slot n already
  holds Pokemon …`). The old bot allowed it; the new schema does not
  (`pokemon_team_id_slot_unique`).
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
| `!pokemon swap\|switch <a> <b>` | swap two slots, or move a Pokémon into an empty one; the Pokémon keep their ids |
| `!pokemon create <user> <pokemon> <level> <shiny 0\|1>` | broadcaster, or a user with the `Admin` role, adds a Pokémon for someone |
| `!chatban`, `!voiceban` | four distinct viewers → the streamer client blocks Enter for 5 min / mutes the mic for 30 s |
| `!chess`, `!rps`, `!dice`, `!ping`, `!commands`, `!quack` | as before |
| `@bro_____bot …` | an OpenAI reply in the old persona, six an hour, only while the streamer client is connected |

Every 30 minutes a wild level-1 Pokémon from the drop dex appears for two
minutes (1 in 8 shiny). Channel-point rewards, received over EventSub:
`Pokemon Create` (a random generation-1–4 Pokémon in the slot typed,
replacing what is there), `Pokemon Level Up` (+1 for the starter),
`Pokemon Roar` (the starter appears on the overlay), `DEBS Alert` (the
viewer's message, censored, appears on the overlay like a news alert; five a
minute across the channel, fulfilled when sent) and `Enable Quacks`. A
redeem that cannot be honoured is refunded. brobot pauses its rewards when
it shuts down and resumes them when it starts. Raids get a shout-out.

**A Pokémon away in pmd-online** (`active_game = 'pmd'`, migration plan §4)
is read-only here: it cannot battle, be swapped, deleted or replaced, level
up or roar. It holds no slot (owner, 2026-10-29): leaving frees its slot, so
a starter that leaves frees slot 1 for a catch or a swap, and coming back
takes the lowest free slot (refused while all six are taken). `!pokemon team`
lists the slotted team, then each away Pokémon as `away in PMD: Lv 81
Groudon`, without a number. A team battle fields the rest of the team.

## Credits

brobot leans on [Twurple](https://github.com/twurple/twurple) for everything
Twitch, and on [Pokémon Showdown](https://github.com/smogon/pokemon-showdown)
(via `@pkmn`) for battles.
