# Sync-server GitHub Actions deploy

Date: 2026-06-10

## Problem

Sync-server deploys are inconsistent. Two paths exist today and neither is what we
want:

- **Manual wrangler** from a developer machine (`pnpm --filter @memry/sync-server
deploy:staging|deploy:production`).
- **Cloudflare Workers Builds** — a Cloudflare-side git integration (connected to
  `memrynote/memry` on 2026-05-07) with a "Deploy default branch" trigger that
  auto-deploys **staging** on every push to `main`. It is currently broken: the
  build runs `pnpm --filter @memry/sync-server test`, which fails in Cloudflare's
  image with a `better-sqlite3` native ABI mismatch (binary built for
  NODE_MODULE_VERSION 140 / Node 25, runtime is 137 / Node 24).

We want deploys driven from GitHub Actions, where the repo controls the toolchain
and the Node version is pinned via `.nvmrc` (24).

## Goals

- Every push to `main` that touches sync-server (or its shared deps) deploys to
  **staging** automatically.
- **Production** deploys are **manual only** and gated by an approval step.
- A typecheck + test gate runs before either deploy.
- Exactly one deploy path: GitHub Actions. The Cloudflare Workers Builds trigger is
  retired so staging does not double-deploy.

## Non-goals

- Automating D1 schema application. `schema/d1.sql` is reset-only (see
  `apps/sync-server/schema/README.md`); applying it is a deliberate, manual,
  out-of-band operation and stays out of these workflows. Deploys ship Worker code
  and bindings only.
- Changing secrets, bindings, routes, or `wrangler.toml` env layout. Both
  `staging` and `production` Worker secrets are already set on Cloudflare.

## Design

Two workflow files. Both deploy with the same command the existing CI dry-run uses,
for consistency and to avoid `cloudflare/wrangler-action`'s monorepo install quirks:

```
pnpm --filter @memry/sync-server exec wrangler deploy --env <staging|production>
```

### `.github/workflows/sync-server-deploy-staging.yml`

- **Trigger:** `push` to `main`, with a `paths:` filter matching the Cloudflare
  trigger's set: `apps/sync-server/**`, `packages/contracts/**`,
  `packages/shared/**`, `packages/rpc/**`, `package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, `turbo.json`, and `.github/workflows/sync-server-deploy-staging.yml`.
- **Concurrency:** group by workflow+ref, `cancel-in-progress: true`, so a newer
  push supersedes an in-flight staging deploy.
- **Job steps:** checkout → pnpm setup → Node from `.nvmrc` → `pnpm install
--frozen-lockfile` → `pnpm typecheck:sync-server` → `pnpm test:sync-server` →
  `wrangler deploy --env staging`.

### `.github/workflows/sync-server-deploy-production.yml`

- **Trigger:** `workflow_dispatch` only (run from the Actions tab).
- **`environment: Production`** — the existing GitHub environment, now configured
  with a required reviewer. The deploy job pauses for approval before running.
- **Concurrency:** group by workflow, `cancel-in-progress: false` (never cancel a
  prod deploy mid-flight).
- **Job steps:** same gate as staging → `wrangler deploy --env production`.

### Auth

- `CLOUDFLARE_API_TOKEN` — new repo secret, Cloudflare "Edit Cloudflare Workers"
  token template, account-restricted. Wrangler reads it from the environment.
- `CLOUDFLARE_ACCOUNT_ID` — repo secret, referenced as `env:` on the deploy step
  (not workflow top-level, where the `secrets` context is not available), because
  `wrangler.toml` has no `account_id`. The value is a non-sensitive identifier; it
  lives in a secret to keep all Cloudflare config out of the YAML.

## Manual one-time setup (operator)

1. Create the Cloudflare API token and add it as repo secret `CLOUDFLARE_API_TOKEN`.
2. Add a required-reviewer rule to the GitHub `Production` environment. **(Done.)**
3. Retire the Cloudflare Workers Builds "Deploy default branch" trigger
   (`e654584e-41c8-4716-a0f5-612940543514`) so staging deploys only from GitHub
   Actions.

## Risks

- **Test-gate flake.** `schema/d1.test.ts` has a recorded flake: 4 cases fail under
  parallel vitest workers but pass solo. As a deploy gate this can block a deploy
  and require a rerun. The gate stays as plain `pnpm test:sync-server` for now; if
  it flakes in practice, the fallback is pinning that run to
  `--no-file-parallelism`.
- **Plan requirement.** Required-reviewer environments need GitHub Pro/Team/
  Enterprise for private repos. Confirmed available (reviewer rule added).
