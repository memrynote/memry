# Sync-server GitHub Actions deploy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy sync-server from GitHub Actions — auto to staging on push to `main`, manual+approved to production — and retire the Cloudflare Workers Builds trigger so there is one deploy path.

**Architecture:** Two workflow files under `.github/workflows/`. Both run the same gate (install → typecheck → test) then `wrangler deploy --env <env>`, using the same command the existing `sync-server-ci.yml` dry-run uses. Staging triggers on `push` to `main` with a paths filter; production triggers on `workflow_dispatch` and binds to the GitHub `Production` environment (required reviewer) for an approval gate. Auth is two repo secrets — `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` — referenced as `env:` on the deploy step.

**Tech Stack:** GitHub Actions, pnpm, Node 24 (`.nvmrc`), Wrangler 4, Cloudflare Workers.

**Spec:** `docs/superpowers/specs/2026-06-10-sync-server-github-actions-deploy-design.md`

> **Note on TDD:** Workflow YAML is not unit-testable. "Verify" steps here are: YAML parse, `wrangler deploy --dry-run` (builds the bundle for the target env without deploying — no token needed, identical to current CI), and finally observing the real Actions run. That is the available evidence; treat a green dry-run + a green real run as the pass condition.

---

## File Structure

- Create: `.github/workflows/sync-server-deploy-staging.yml` — push-to-main auto deploy to staging.
- Create: `.github/workflows/sync-server-deploy-production.yml` — manual, approval-gated deploy to production.
- Unchanged: `.github/workflows/sync-server-ci.yml` (PR/push validation + dry-run) stays as-is.
- External (no repo file): Cloudflare Workers Builds trigger `e654584e-41c8-4716-a0f5-612940543514` — deleted via API.

---

## Task 1: Create the staging deploy workflow

**Files:**

- Create: `.github/workflows/sync-server-deploy-staging.yml`

- [ ] **Step 1: Write the workflow file**

Create `.github/workflows/sync-server-deploy-staging.yml` with exactly:

```yaml
name: Deploy sync-server (staging)

on:
  push:
    branches:
      - main
    paths:
      - 'apps/sync-server/**'
      - 'packages/contracts/**'
      - 'packages/shared/**'
      - 'packages/rpc/**'
      - 'package.json'
      - 'pnpm-lock.yaml'
      - 'pnpm-workspace.yaml'
      - 'turbo.json'
      - '.github/workflows/sync-server-deploy-staging.yml'

concurrency:
  group: sync-server-deploy-staging-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  deploy:
    name: Typecheck, test, and deploy to staging
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          run_install: false

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck sync-server
        run: pnpm typecheck:sync-server

      - name: Test sync-server
        run: pnpm test:sync-server

      - name: Deploy to staging
        run: pnpm --filter @memry/sync-server exec wrangler deploy --env staging
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- [ ] **Step 2: Verify the YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/sync-server-deploy-staging.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Verify the staging Worker bundle builds**

Run: `pnpm --filter @memry/sync-server exec wrangler deploy --dry-run --outdir .wrangler/ci-staging --env staging`
Expected: Wrangler prints "Total Upload" / "Dry run: exiting now." with exit 0, no deploy.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/sync-server-deploy-staging.yml
git commit -m "ci(sync-server): add GitHub Actions staging deploy on push to main"
```

---

## Task 2: Create the production deploy workflow

**Files:**

- Create: `.github/workflows/sync-server-deploy-production.yml`

- [ ] **Step 1: Write the workflow file**

Create `.github/workflows/sync-server-deploy-production.yml` with exactly:

```yaml
name: Deploy sync-server (production)

on:
  workflow_dispatch:

concurrency:
  group: sync-server-deploy-production
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  deploy:
    name: Typecheck, test, and deploy to production
    runs-on: ubuntu-latest
    timeout-minutes: 25
    environment:
      name: Production
      url: https://sync.memrynote.com
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          run_install: false

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck sync-server
        run: pnpm typecheck:sync-server

      - name: Test sync-server
        run: pnpm test:sync-server

      - name: Deploy to production
        run: pnpm --filter @memry/sync-server exec wrangler deploy --env production
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- [ ] **Step 2: Verify the YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/sync-server-deploy-production.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Verify the production Worker bundle builds**

Run: `pnpm --filter @memry/sync-server exec wrangler deploy --dry-run --outdir .wrangler/ci-prod --env production`
Expected: Wrangler prints "Dry run: exiting now." with exit 0, no deploy.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/sync-server-deploy-production.yml
git commit -m "ci(sync-server): add manual approval-gated GitHub Actions production deploy"
```

---

## Task 3: Provision the Cloudflare API token secret (operator)

This is a manual Cloudflare + GitHub step. It must be done before either workflow's
deploy step can succeed, but it does not block committing the workflow files.

- [ ] **Step 1: Create the Cloudflare API token**

In the Cloudflare dashboard → My Profile → API Tokens → Create Token → use the
**"Edit Cloudflare Workers"** template. Set:

- **Account Resources:** Include → `Kaan94karaca@gmail.com's Account` (47b83566bd8a59e0ff5ddb585f63de83)
- **Zone Resources:** Include → Specific zone → `memrynote.com` (required — the Workers
  publish to the routes `sync.memrynote.com/*` and `sync-staging.memrynote.com/*`).

Create and copy the token value.

- [ ] **Step 2: Add it as a repo secret**

Run (paste the token when prompted):

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo memrynote/memry
```

- [ ] **Step 3: Add the account id as a repo secret**

The deploy step also reads `CLOUDFLARE_ACCOUNT_ID` (a non-sensitive identifier kept
in a secret to keep all Cloudflare config out of the YAML):

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID --repo memrynote/memry --body 47b83566bd8a59e0ff5ddb585f63de83
```

- [ ] **Step 4: Verify both secrets exist**

Run: `gh secret list --repo memrynote/memry | grep -i cloudflare`
Expected: lines for both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

---

## Task 4: Retire the Cloudflare Workers Builds staging trigger

Removes the duplicate staging deploy path. Reversible — the trigger can be recreated
from the Cloudflare dashboard (Workers & Pages → memry-sync-server-staging → Settings
→ Builds) by reconnecting the repo.

- [ ] **Step 1: Confirm the trigger still exists and capture its config**

Use the Cloudflare API MCP `execute` tool:

```js
;async () => {
  const r = await cloudflare.request({
    method: 'GET',
    path: `/accounts/${accountId}/builds/workers/memry-sync-server-staging/triggers`
  })
  return r.result
}
```

Expected: an array containing the trigger with `trigger_uuid` `e654584e-41c8-4716-a0f5-612940543514`. (If the array is empty, the trigger was already removed — skip Step 2.)

- [ ] **Step 2: Delete the trigger**

```js
;async () => {
  const r = await cloudflare.request({
    method: 'DELETE',
    path: `/accounts/${accountId}/builds/triggers/e654584e-41c8-4716-a0f5-612940543514`
  })
  return { success: r.success, status: r.status, errors: r.errors }
}
```

Expected: `{ success: true, status: 200, errors: [] }`.

- [ ] **Step 3: Verify no triggers remain**

```js
;async () => {
  const r = await cloudflare.request({
    method: 'GET',
    path: `/accounts/${accountId}/builds/workers/memry-sync-server-staging/triggers`
  })
  return r.result
}
```

Expected: `[]`.

---

## Task 5: End-to-end verification

Run after Tasks 1–4 are merged to `main` and the secret exists.

- [ ] **Step 1: Confirm the staging workflow fired and deployed**

Push the workflow commits to `main` (the staging workflow's own path is in the filter,
so adding the file triggers it). Then:

Run: `gh run list --repo memrynote/memry --workflow "Deploy sync-server (staging)" --limit 1`
Expected: one run, conclusion `success`.

Confirm the deploy actually landed:

```js
;async () => {
  const r = await cloudflare.request({
    method: 'GET',
    path: `/accounts/${accountId}/workers/scripts`
  })
  return r.result.find((s) => s.id === 'memry-sync-server-staging')
}
```

Expected: `modified_on` timestamp is newer than before the run.

- [ ] **Step 2: Confirm the production workflow requires approval**

Run: `gh workflow run "Deploy sync-server (production)" --repo memrynote/memry --ref main`
Then: `gh run list --repo memrynote/memry --workflow "Deploy sync-server (production)" --limit 1`
Expected: the run shows status `waiting` (blocked on the `Production` environment
required-reviewer rule) — it does NOT deploy on its own.

- [ ] **Step 3: Approve and confirm production deploy**

Approve the waiting run in the GitHub UI (Actions → the run → Review deployments →
Approve and deploy), or:

```bash
# find the pending deployment id, then approve
run_id=$(gh run list --repo memrynote/memry --workflow "Deploy sync-server (production)" --limit 1 --json databaseId --jq '.[0].databaseId')
gh api repos/memrynote/memry/actions/runs/$run_id/pending_deployments \
  -f 'environment_ids[]=15054417160' -f state=approved -f comment='deploy'
```

Expected: run resumes, conclusion `success`; `memry-sync-server-production` `modified_on`
updates.

- [ ] **Step 4: Final sanity — both endpoints respond**

Run:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://sync-staging.memrynote.com/health || true
curl -s -o /dev/null -w "%{http_code}\n" https://sync.memrynote.com/health || true
```

Expected: HTTP 200 (or the health route's documented status) from both. If the route is
not `/health`, substitute the real health/root route.

---

## Self-Review

- **Spec coverage:** push→staging (Task 1), manual+approval prod (Task 2 + env), test gate both (Tasks 1–2 steps), single path / retire CF trigger (Task 4), auth secret + inlined account id (Task 3 + env blocks), schema apply intentionally excluded (no task — matches non-goal). All covered.
- **Placeholder scan:** none — full YAML and exact commands in every step. The only conditional ("if route is not /health") is a real fallback, not a placeholder.
- **Consistency:** account id `47b83566bd8a59e0ff5ddb585f63de83`, trigger uuid `e654584e-41c8-4716-a0f5-612940543514`, env id `15054417160` (GitHub `Production`), and script names `memry-sync-server-staging|production` are used consistently across tasks.
