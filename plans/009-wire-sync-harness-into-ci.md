# Plan 009: Run the cross-boundary sync protocol harness in CI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 86ee0cd1..HEAD -- .github/workflows/sync-server-ci.yml package.json tests/sync-harness`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `86ee0cd1`, 2026-06-12
- **Issue**: https://github.com/memrynote/memry/issues/550

## Why this matters

`tests/sync-harness` (`@memry/sync-harness`) is the only suite that exercises the **end-to-end sync protocol across the desktop↔server boundary**: simulated devices encrypt, push, pull, and converge against a Miniflare-hosted worker, with conflict-resolution, multi-device, edge-case, and negative-crypto scenarios. Desktop unit tests mock the server and server unit tests mock the client, so a serialization or vector-clock-encoding bug that only manifests _between_ the two would pass both suites and still ship. This harness is exactly the regression net for that class of bug — but it runs in **no CI workflow and no root test script**, so it only catches regressions if someone remembers to run it by hand. Wiring it into CI makes the protocol contract a gate.

## Current state

- The harness is a workspace package: `tests/sync-harness/package.json` → `@memry/sync-harness`.
  - `build:worker` = `tsx scripts/build-worker.ts` (bundles `dist/worker.mjs`).
  - `test` = `vitest run`.
  - Vitest config (`tests/sync-harness/vitest.config.ts`) sets `fileParallelism: false` and 30s timeouts — it is already configured to avoid the parallel-worker flakiness seen in other suites.
  - Dependencies are pure JS/WASM (`libsodium-wrappers-sumo`, `miniflare`, `cborg`, `jose`, `pako`) — **no native ABI rebuild** (no `better-sqlite3`/`keytar`), so it needs no `ensure-native` dance.
- Test files: `tests/sync-harness/tests/{basic-convergence,conflict-resolution,multi-device,edge-cases,negative-crypto}.test.ts`.
- It is referenced in **no** `.github/workflows/*` and **not** in the root `package.json` `test` script.
- The natural home is `.github/workflows/sync-server-ci.yml`, which already sets up pnpm + Node from `.nvmrc`, does a frozen install, and runs sync-server typecheck/test. Its trigger `paths` already include `apps/sync-server/**`, `packages/contracts/**`, `packages/sync-core/**`, `packages/shared/**` — the surfaces the harness validates. That workflow's existing job is named `sync-server`.

Current tail of the `sync-server` job in `.github/workflows/sync-server-ci.yml`:

```yaml
- name: Test sync-server
  run: pnpm test:sync-server

- name: Validate Worker bundle
  run: pnpm --filter @memry/sync-server exec wrangler deploy --dry-run --outdir .wrangler/ci --env staging
```

## Commands you will need

| Purpose                     | Command                                          | Expected on success                                 |
| --------------------------- | ------------------------------------------------ | --------------------------------------------------- | -------------------------- | ------------- |
| Build the harness worker    | `pnpm --filter @memry/sync-harness build:worker` | exit 0, writes `tests/sync-harness/dist/worker.mjs` |
| Run the harness             | `pnpm --filter @memry/sync-harness test`         | all suites pass                                     |
| Lint workflow YAML (sanity) | `node -e "require('js-yaml')" 2>/dev/null        |                                                     | echo "no yaml lib — skip"` | informational |

## Scope

**In scope** (modify):

- `.github/workflows/sync-server-ci.yml` — add a build-worker step and a harness-test step; add `tests/sync-harness/**` to both `paths` trigger lists.
- `package.json` (root) — add a `test:sync-harness` convenience script.

**Out of scope** (do NOT touch):

- The harness source/tests themselves (`tests/sync-harness/src`, `tests/sync-harness/tests`) — do not modify tests to make them pass.
- The root `test` turbo script (line 35) — do not add the harness there; it has its own Miniflare setup and is better run as an explicit CI step than folded into the turbo `test` fan-out.
- `desktop-ci.yml` and other workflows.

## Git workflow

- Branch: `ci/run-sync-harness` (from `origin/main`).
- Commit message: `ci(sync-server): run the cross-boundary sync protocol harness`.
- Do NOT push or open a PR unless instructed. No `Co-Authored-By` trailers.

## Steps

### Step 1: Confirm the harness is green locally BEFORE wiring it as a gate

In the worktree, after `pnpm install --frozen-lockfile`:

```
pnpm --filter @memry/sync-harness build:worker
pnpm --filter @memry/sync-harness test
```

**Verify**: both commands exit 0 and all harness suites pass. **If the harness does not pass cleanly locally** (failures or flakiness across two runs), **STOP and report** — do not wire a failing/flaky suite into CI as a hard gate. Re-run once to distinguish a flake from a consistent failure; report which suites fail and how.

### Step 2: Add a root convenience script

In root `package.json` `scripts`, add (next to the other `test:*` scripts):

```json
"test:sync-harness": "pnpm --filter @memry/sync-harness build:worker && pnpm --filter @memry/sync-harness test"
```

**Verify**: `pnpm test:sync-harness` → exit 0, suites pass.

### Step 3: Add the harness steps to the sync-server CI job

In `.github/workflows/sync-server-ci.yml`, insert two steps into the `sync-server` job, after `Test sync-server` and before `Validate Worker bundle`:

```yaml
- name: Build sync-harness worker
  run: pnpm --filter @memry/sync-harness build:worker

- name: Run sync protocol harness
  run: pnpm --filter @memry/sync-harness test
```

Keep the existing steps and the job's `timeout-minutes` (bump it only if the harness pushes total runtime near the limit; note the change if so).

### Step 4: Add the harness path to the workflow triggers

In the same file, add `- 'tests/sync-harness/**'` to **both** the `on.pull_request.paths` and `on.push.paths` lists so changes to the harness itself re-run it.

**Verify**: the YAML is well-formed — `grep -n "tests/sync-harness" .github/workflows/sync-server-ci.yml` shows it in the paths lists and the two new steps; indentation matches the surrounding steps (6 spaces for `- name:` under `steps:`).

## Test plan

This plan adds CI coverage rather than code; "tests" here are the harness suites themselves now running in CI. Verification:

- Local: `pnpm test:sync-harness` passes (Step 1/2).
- YAML: the two steps and the trigger path are present and correctly indented (Step 4 verify).
- (If the operator pushes the branch) the `Sync Server CI` workflow runs the new steps and they pass.

## Done criteria

ALL must hold:

- [ ] `pnpm test:sync-harness` exists in root `package.json` and passes locally.
- [ ] `.github/workflows/sync-server-ci.yml` runs `build:worker` then the harness test in the `sync-server` job.
- [ ] `tests/sync-harness/**` is in both the `pull_request` and `push` `paths` triggers.
- [ ] YAML indentation matches the surrounding steps (no tab/space errors).
- [ ] `git status` shows only `.github/workflows/sync-server-ci.yml` and root `package.json` (plus `plans/README.md`) modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- The harness is **not green locally** (Step 1) — wiring a red/flaky gate is worse than no gate. Report the failing suites; the maintainer may need to fix the harness first or quarantine a suite.
- `build:worker` fails (e.g. a missing build dependency in the worktree) — report the error; do not commit a workflow that would fail at the build step.
- The harness needs secrets or external network access you can't provide in CI — report it; it may need a Miniflare-only mode.
- Total CI runtime would exceed the job's `timeout-minutes` — note it and propose a separate job instead of inflating the timeout silently.

## Maintenance notes

- The harness is intentionally `fileParallelism: false`; if a contributor "speeds it up" by enabling parallelism, expect the documented two-device flakiness to return.
- If a future change splits the sync protocol types into a new package, add that package to the workflow `paths` triggers so the harness still runs on relevant changes.
- A reviewer should confirm the harness actually ran (not skipped) in the first CI run on the branch, and that it gates (not `continue-on-error`).
- Deferred: a similar gap may exist for desktop↔CLI integration (`apps/cli` has command-parsing tests but not full vault round-trips). Separate finding; not in this plan.
