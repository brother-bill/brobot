# brobot deploy templates

Empty on purpose. Ticket **I1** of `guidelines/brobot/migration-plan.md` fills
this directory: the Terraform module (`machines` map, Cloudflare DNS, firewall),
the compose file (api, postgres, nginx, certbot, autoheal), the nginx server
blocks, the `deploy-brobot.yml` workflow template, `materialize.sh`, and the
cutover runbook (plan §6).

Everything committed here is secret-free (hostnames only).
`materialize.sh` copies it into the gitignored `infra/brobot/`, where the
operator keeps tfvars, certificates and keys.

What B1 fixed for I1 to rely on:

- The image is `Dockerfile.brobot.prod` at the superproject root.
- The API listens on `PORT` (default 3000) and runs migrations **at start**
  (`RUN_MIGRATIONS`, default true). Give the container healthcheck a
  `start_period` long enough for a migration.
- Healthcheck target: `GET /api/health/live` (touches no database).
- `trust proxy` accepts private-range hops only. nginx must put the real
  client address in `X-Forwarded-For` (behind Cloudflare: `real_ip_header
  CF-Connecting-IP` with Cloudflare's ranges in `set_real_ip_from`), or every
  client shares one rate-limit bucket.
- The streamer socket is `wss://<api host>/api/ashketchum`; nginx needs the
  usual `Upgrade`/`Connection` headers on that location.
- Postgres is never published outside the compose network (plan §7: the old
  RDS answered on 5432 from the internet).
