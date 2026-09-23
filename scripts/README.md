# brobot scripts

One-off operator scripts that run against brobot's database. Ticket **B3**
adds `import-prisma-dump.ts` here: it reads a `pg_dump` of the old RDS
database and writes it into the new schema (idempotent, with a dry run).

Notes for that import, from B1:

- Every table is a column map from the Prisma schema: camelCase → snake_case,
  PascalCase tables → snake_case (`TwitchUser` → `twitch_user`,
  `userOauthId` → `user_oauth_id`, `teamId` → `team_id`).
- Primary keys keep their values. The old ids are `text` holding UUIDs
  (Prisma `@default(uuid())`); the new columns are `uuid`, so cast them.
- Prisma's `String[]` columns were nullable `text[]`; the new ones are
  `NOT NULL DEFAULT '{}'`. Write `{}` for NULL.
- `Session` is not imported (sessions are JWTs now).
- New `pokemon` columns take their defaults: `active_game = 'brobot'`, the
  other three NULL.
- `pokemon.slot` now has a `1..6` check. The old code tolerated duplicate
  slots in one team (it even de-duplicated them when redeeming), so count
  `(team_id, slot)` duplicates in the dump before importing.
