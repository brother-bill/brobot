# brobot scripts

One-off operator scripts that run against brobot's database.

## `import-prisma-dump.ts` (ticket B3)

Old Prisma database → new schema, through MikroORM. Usage, flags and
guarantees are in the app README ("Importing the old database") and in
`pnpm run import:prisma-dump -- --help`. The logic lives in
`src/modules/transfer/import/` (so it is linted, typechecked and unit
tested with the app). This file is only the process entry point.

How the column map works:

- Every table is a column map from the Prisma schema: camelCase → snake_case,
  PascalCase tables → snake_case (`TwitchUser` → `twitch_user`,
  `userOauthId` → `user_oauth_id`, `teamId` → `team_id`). The old column
  list is `src/modules/transfer/import/old-schema.ts`, taken from the only
  Prisma migration (`git show 02854fb:prisma/migrations/20221130130640_init/migration.sql`).
- Primary keys keep their values. The old ids are `text` holding UUIDs; the
  new columns are `uuid`. A value that is not a uuid fails its row.
- Prisma's `TIMESTAMP(3)` columns have no zone and hold UTC; they are read as UTC.
- Both sources (a dump's `COPY` blocks, or `--from-db` selecting every column
  `::text`) produce the same text rows, so there is one set of mappers.
