# deploy/github — brobot's workflows, staged for `.github/workflows/`

Agents cannot edit `.github/workflows/**` (the fleet publisher refuses the
branch), so brobot's CI lands here first and **the owner copies it in**, as in
singularity's `deploy/github/`. Nothing here runs until then.

| File | Installs as | What it does |
|---|---|---|
| `contract.yml` | `.github/workflows/contract.yml` | On a pull request touching `openapi.json`, `served-routes.json`, `contract-lint-ignore.txt` or `src/http/`, calls singularity's reusable `contract-check.yml`: singularity's lint ruleset on `openapi.json` with `contract-lint-ignore.txt` as its `lint-ignore` input, then the served-routes parity check on the committed `served-routes.json`. Not installed. |

## `contract.yml`: owner steps, in order

singularity's guide is `libs/contracts/docs/publishing-a-contract.md` §6; its
side of these steps is singularity's `deploy/github/README.md`, "The contract
registry and contract-check.yml (2026-11-16)".

1. **In singularity**, install the reusable workflow: from a checkout of
   `main`, `cp deploy/github/contract-check.yml .github/workflows/`, delete its
   row from the install queue in `deploy/github/README.md`, run
   `pnpm run check:staged-workflows`, commit and push to `main`. Note that
   commit's full SHA: it is the pin below, and it must be a commit on
   singularity's `main` whose `.github/workflows/` holds `contract-check.yml`.
2. **In singularity**, *Settings → Actions → General → Access*: "Accessible
   from repositories owned by" the owner's account, so brobot may call a
   workflow of that private repository.
3. **In brobot**, *Settings → Secrets and variables → Actions*, a repository
   secret `SINGULARITY_CONTRACTS_TOKEN`: a fine-grained token with
   *Contents: read* on singularity alone (no other repository, no other
   permission). brobot's own `GITHUB_TOKEN` cannot read singularity.
4. **In brobot**, install the caller pinned at step 1's SHA, on a branch, and
   open a pull request; it touches `.github/workflows/contract.yml`, so the
   `Contract` workflow runs on that pull request:

   ```bash
   SHA=<step 1's 40-character commit>
   mkdir -p .github/workflows
   sed "s/SINGULARITY_CONTRACT_CHECK_SHA/$SHA/g" deploy/github/contract.yml > .github/workflows/contract.yml
   # from the superproject: node scripts/pin-github-actions.mjs --check apps/brobot/.github/workflows/contract.yml
   ```

   Then mark `contract.yml` installed in the table above, and replace the
   placeholder in the staged copy with the same SHA, so the two match.

The job is `Contract / contract / Contract lints clean and matches what is
served`. Green means both checks passed at the pinned singularity commit; red
names the lint finding or the parity finding. A failure to check out
`brother-bill/singularity` is step 2 or 3.

Moving the pin later (a change to singularity's ruleset or checker reaching
brobot) is a pull request here changing both SHAs in `contract.yml` together:
the `uses:` ref and `singularity-ref`.

Rollback: delete `.github/workflows/contract.yml`; nothing else depends on it.
