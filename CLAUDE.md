# brobot — agent notes

Start with `README.md` (layout, checks, auth model) and the superproject's
`guidelines/PROJECT.md`. This file holds what an agent needs on top of them.

## Environment and the config store

`src/config/env.schema.ts` is the authority on every variable: the zod schema
decides what boots, and each key also carries the config store's metadata
(`kind`, `description`, `requiredBy`, `default`) in the shape api-time's
`src/env/env.schema.ts` uses. Changing a key means:

1. edit it there, metadata included (a spec fails when `requiredBy`/`default`
   disagree with the zod schema);
2. `pnpm run env:schema` and commit `env.schema.json` (a spec fails when it is
   stale);
3. a new non-bootstrap key must also be allowlisted in singularity-infra's
   `k8s/charts/brobot`, or the k3s Secret never carries it — say so in the
   handoff; that repo is not edited from here.

| Kind | Keys | Where the value lives |
|---|---|---|
| `bootstrap` | `NODE_ENV`, `PORT`, `DATABASE_URL`, `RUN_MIGRATIONS` | the deploy: the image / chart, `DATABASE_URL` from the CNPG Secret. The store refuses them. |
| `secret` | `JWT_*`, `BROBOT_SERVICE_TOKEN`, `TWITCH_CLIENT_SECRET`, `EVENT_SUB_SECRET`, `WS_SECRET`, `RIOT_API_KEY`, `LICHESS_AUTH_TOKEN`, `OPEN_API_KEY`, `STREAMLABS_SECRET` | prod: 1Password vault `brobot-prod`, as `op://` references. dev: stored in the store. |
| `plain` | ids, usernames, callback URLs, `UI_URL`, `OPENAI_MODEL`, the `TWITCH_*_ENABLED` switches, Streamlabs client id / redirect URI | the store, readable |
| `topology` | `DOMAIN`, `ALLOWED_ORIGINS` | the store; the natural per-target override |

The store is api-time's `/admin/config` (its `src/app-modules/config/README.md`
is the reference). k3s renders the `brobot-env` Secret from the
`brobot/prod/eu` bundle through ESO.

### Importing prod and dev config

`config:import` is api-time's command, run from `apps/api-time` with api-time's
database env (see that README). `--schema` registers brobot's schema, or syncs
it, on the first real run; its path is relative to `apps/api-time`. Always
`--dry-run` first: it prints the key names sorted into write / refs /
bootstrap / empty, never a value.

```bash
# prod — secret keys become op://brobot-prod/<KEY>/credential, whatever their value in the file
pnpm run config:import -- --app brobot --env prod --file <brobot-prod.env> \
  --schema ../brobot/env.schema.json --as-refs brobot-prod --dry-run

# dev — values stored directly; no --as-refs
pnpm run config:import -- --app brobot --env dev --file <brobot-dev.env> \
  --schema ../brobot/env.schema.json --dry-run
```

- Without `--target`, values are stored for the whole environment, which the
  `eu` token reads too. Add `--target eu` only for a value that is eu-specific.
- `--as-refs` turns **every** secret key in the file into a reference, blank
  ones included, and creates nothing in 1Password. Delete the lines of
  integrations prod does not use (e.g. `RIOT_API_KEY`, `STREAMLABS_SECRET`)
  before importing, or every render fails with 502 naming the missing item.
- Bootstrap keys in the file are skipped, not stored.
- A bundle is refused with 409 naming the keys while any required key is
  missing, so a partly imported environment renders nothing.

### A developer's dev config

An operator creates a personal, revocable bundle token scoped to brobot/dev:
`POST /api/admin/config/tokens` `{"app": "brobot", "environment": "dev", "label": "dev-<name>"}`.
The `cfg_…` plaintext is in that response only. Revoke it with
`POST /api/admin/config/tokens/:id/revoke`.

The developer then runs, from `apps/brobot`:

```bash
read -rs BROBOT_CONFIG_TOKEN && export BROBOT_CONFIG_TOKEN   # paste the cfg_… token
pnpm run config:pull-dev
```

It calls `GET https://api.tahatime.com/api/config/bundle?app=brobot&env=dev`
with the token as a bearer (`CONFIG_API_URL` overrides the base), then writes
`.env` with mode 600 and keeps the previous file as `.env.prev`. The bootstrap lines
(`DATABASE_URL`, …) come from the current `.env`, or from `.env.example` when
there is none, because the bundle never holds them. The token comes from the
environment only, never from argv. Only key names are printed.

Use the script rather than `curl -H 'Accept: text/plain'`: that dotenv escapes
`\`, `"` and `$` for docker compose, and the dotenv parser Nest uses does not
undo those escapes.
