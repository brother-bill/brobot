# brobot deploy

Nothing deploys from this directory. It once waited for ticket **I1** of
`guidelines/brobot/migration-plan.md` (Terraform, compose, nginx,
`materialize.sh`); the k3s chart replaced that plan before it shipped.

Where the deploy lives:

- **Image**: `Dockerfile.brobot.prod` at the superproject root, built by the
  superproject's `.github/workflows/build-brobot.yml` and pushed as
  `ghcr.io/brother-bill/brobot-api`.
- **Chart and Flux objects**: singularity-infra, `k8s/charts/brobot` and
  `k8s/platform/apps/brobot-release.yaml`. A new non-bootstrap env key must be
  allowlisted in that chart (see `CLAUDE.md`).
- **Database**: the CNPG cluster `brobot-db`, from that chart, backed up to R2.
- The 2023 bot's EC2 host and RDS database were deleted on 2026-10-21
  (singularity-infra `runbooks/aws-exit.md`).

What B1 fixed for whatever runs the image:

- The API listens on `PORT` (default 3000) and runs migrations at start when
  `RUN_MIGRATIONS` is true (the default). The chart sets it to false on the
  long-running pods and migrates in a pre-upgrade Job, or in an init container
  on first install.
- Liveness target: `GET /api/health/live` (touches no database).
- `trust proxy` accepts private-range hops only. The proxy in front must put
  the real client address in `X-Forwarded-For` (behind Cloudflare, taken from
  `CF-Connecting-IP`), or every client shares one rate-limit bucket.
- The streamer socket is `wss://<api host>/api/ashketchum`; the route to it
  must pass the `Upgrade`/`Connection` headers through.
- Postgres is never published outside the cluster (plan §7: the old RDS
  answered on 5432 from the internet).
