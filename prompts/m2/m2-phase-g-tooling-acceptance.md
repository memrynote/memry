# M2 Phase G — Tooling + Acceptance + PR

Temiz session prompt. Device profiles, dev scripts, 1000-row bench, final gate + PR. M2'yi kapatma phase'i.

---

## PROMPT START

You are implementing **Phase G of Milestone M2** for Memry's Electron→Tauri migration. This is the final phase — dev tooling, command-parity audit, M2 native-wrapper hardening, performance bench, acceptance gate, and PR. No new feature-domain logic; wrap-up and polish.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2`
**Branch:** `m2/db-schemas-migrations`
**Plan:** `docs/superpowers/plans/2026-04-25-m2-db-schemas-migrations.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` (§4 M2, "Full Electron parity inventory", §5.5 testing, §5.6 dev workflow)
**Prompts README:** `prompts/m2/README.md`

### Prerequisite verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2

# Phase F complete — settings end-to-end working
grep -q 'settings_get' apps/desktop-tauri/src/generated/bindings.ts
grep -q 'settings_get' apps/desktop-tauri/src/lib/ipc/invoke.ts
test -f apps/desktop-tauri/src-tauri/tests/settings_test.rs

# All tests green
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -5
# Expect all passing (≥ 24 tests total)

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri bindings:check

# Commits so far (Phases A-F)
git log --oneline | grep -cE 'm2\('
# Expect ≥ 12
```

If any fails, STOP.

### Your scope

Execute **Tasks 16, 17, 18, 19** from the plan:

- **Task 16:** `MEMRY_DEVICE=A/B` dev scripts in `package.json` (code from Phase A already reads the env var).
- **Task 17:** `scripts/dev-reset.sh` + `scripts/new-migration.ts` + `scripts/schema-diff.ts` + `scripts/command-parity-audit.ts` + register in `package.json`; replace renderer `electron-log/renderer`; harden `port:audit`; align updater mock command names; add/classify the minimal shell-neutral native wrappers required by the updated spec.
- **Task 18:** `src/bin/bench_m2.rs` — 1000-row list query, p50 < 20ms assertion, release-build required.
- **Task 19:** Full acceptance gate verification + required schema-diff against Electron data DB + push branch + open PR.

### Methodology — mix of verification + TDD

1. **Invoke `superpowers:using-superpowers`** and optionally `superpowers:verification-before-completion` (for Tasks 16-18) / `superpowers:finishing-a-development-branch` (for Task 19).

2. **Task 16 — device profiles:**
   - Edit `apps/desktop-tauri/package.json` scripts: add `"dev:a": "MEMRY_DEVICE=A tauri dev"` and `"dev:b": "MEMRY_DEVICE=B tauri dev"`.
   - Verify `resolve_db_path` in `src-tauri/src/lib.rs` reads `MEMRY_DEVICE` (from Phase A Task 2.4).
   - Smoke: `pnpm dev:a` → quit → `pnpm dev:b` → quit → `ls ~/Library/Application\ Support/com.memry.memry/` → expect `memry-A` and `memry-B` dirs.
   - Commit: `m2(devx): add MEMRY_DEVICE=A/B dev scripts`.

3. **Task 17 — dev scripts + port hygiene + M2 parity hardening:**
   - `scripts/dev-reset.sh`: bash script per plan Step 17.1. `chmod +x`.
   - `scripts/new-migration.ts`: TypeScript helper per plan Step 17.2. Uses `tsx` (already in devDeps).
   - `scripts/schema-diff.ts`: TypeScript helper per plan Step 17.3. Requires `better-sqlite3` as dev-dep — add via `pnpm add -D better-sqlite3 @types/better-sqlite3`.
   - `scripts/command-parity-audit.ts`: TypeScript helper required by the 2026-04-25 design review. It must inspect:
     - Electron source surfaces: `packages/contracts/src/**`, `apps/desktop/src/preload/**`, and `generated-ipc-invoke-map.ts`.
     - Tauri renderer calls: literal `invoke('...')` calls and `createInvokeForwarder` route use under `apps/desktop-tauri/src`.
     - Tauri mock registry: `apps/desktop-tauri/src/lib/ipc/mocks/**`.
     - Real Rust coverage: `src-tauri/src/commands/**`, `generate_handler![]`, and `src/generated/bindings.ts`.
     - Output classifications: `real`, `mocked`, `renderer-only`, `retired`, or `deferred:<milestone>`.
     - M2 rule: `settings_get`, `settings_set`, `settings_list` must be `real`; other feature-domain calls may be `mocked`/`deferred`; unclassified renderer calls and renderer/mock name mismatches fail.
   - Update `package.json` scripts: `db:new-migration`, `db:schema-diff`, `db:reset`, `command:parity`.
   - Replace `apps/desktop-tauri/src/lib/logger.ts`'s `electron-log/renderer` dependency with a Tauri-safe local logger. Do not use raw `console.*` in production paths; an M2 interim no-op/dev-gated logger is acceptable if full Rust log forwarding is deferred.
   - Harden `port:audit` so it catches renderer Electron imports, `electron-log/renderer`, and high-risk `@memry/*` package residue. Record before/after `@memry/*` counts for the PR carry-forward ledger.
   - Align updater mocks/tests with renderer usage from `src/hooks/use-app-updater.ts`:
     - Replace or add mocked routes for `updater_get_state`, `updater_check_for_updates`, `updater_download_update`, and `updater_quit_and_install`.
     - Return the `AppUpdateState` shape the hook expects, with `status: 'unavailable'` and `updateSupported: false` until M9.
     - Do not keep old `updater_check` / `updater_download` / `updater_install` names unless `command:parity` explicitly marks them as legacy no-renderer routes. Prefer deleting/renaming the old mock names and updating tests.
   - Add or classify the minimal shell-neutral app commands the renderer already assumes exist:
     - `notify_flush_done` should be a real no-op/logging command if `use-flush-on-quit.ts` still invokes it.
     - Window controls count as implemented if the renderer uses `@tauri-apps/api/window` directly and tests cover close/minimize/maximize; do not invent duplicate Rust commands.
     - `logging_forward` may be a thin real command if the new logger forwards production errors; otherwise classify it as deferred to the M8.0 lifecycle/logging work with no production call site.
   - Smoke-test each:
     - `pnpm db:new-migration test_scaffold` → file created at `0030_test_scaffold.sql` → delete it.
     - `pnpm db:reset A` → `ls ~/Library/Application\ Support/com.memry.memry/memry-A` → not found.
     - `pnpm port:audit` → exits 0 after logger/import cleanup.
     - `pnpm command:parity` → exits 0 with no unclassified renderer commands and no updater name mismatch.
     - `pnpm db:schema-diff` full test deferred to Task 19.
   - Commit: `m2(devx): add dev scripts and parity audit`.

4. **Task 18 — 1000-row bench:**
   - Create `src/bin/bench_m2.rs` per plan Step 18.1. Includes:
     - `Db::open_memory` → insert 1000 tasks under one project using one local transaction on the guarded connection.
     - Warm-up: 5 iterations of the 1000-row SELECT.
     - Measurement: 100 iterations, collect `Instant::now()` deltas in microseconds.
     - Sort samples, print p50 and p95, assert p50 < 20_000µs (20ms).
   - Add `[[bin]] name = "bench_m2" path = "src/bin/bench_m2.rs" required-features = ["test-helpers"]` to `Cargo.toml`.
   - Run `cargo run --release --bin bench_m2 --features test-helpers`.
   - Verify output like `1000-row list: p50 = <X>µs, p95 = <Y>µs`. Assert passes — if fails, diagnose (release mode? indexes? prepared statement?).
   - Commit: `m2(bench): 1000-row list query p50 < 20ms acceptance test`.

5. **Task 19 — acceptance gate + PR:**
   - Run **all** acceptance commands from plan Step 19.1. Every command must exit 0.
   - Count Rust tests per plan Step 19.2: expect ≥ 20 (plan estimates ~24).
   - **Required** schema-diff (plan Step 19.3): run Electron app once to populate its data DB, run Tauri once to populate `data.db`, then `pnpm db:schema-diff <electron-data-db> <tauri-data.db>`. Triage any diffs — report to user, do not silently accept. If the Electron data DB cannot be produced, stop and report the blocker instead of marking schema parity complete.
   - Push branch: `git push -u origin m2/db-schemas-migrations`.
   - Open PR via `gh pr create` with title + body per plan Step 19.4.
   - Do NOT merge. User owns the merge decision (typically via `/land-and-deploy` gstack skill).

### Critical gotchas

1. **Release build for bench:** `cargo run --release` is mandatory (spec Risk #7). Debug build can be 10× slower on SQLite. If you run without `--release` and see p50 > 20ms, that's a false failure.
2. **Transaction scope in bench:** M2 uses one `Arc<Mutex<Connection>>`, not a pool. Hold the connection guard only while seeding/querying, keep the transaction local to the bench, and do not introduce a pool just for benchmarking.
3. **`better-sqlite3` native binding:** `schema-diff.ts` needs `better-sqlite3`'s native module. If `pnpm install` fails with binding compile errors, confirm Xcode CLI tools installed (`xcode-select -p`). On M1/M2 Mac, `pnpm rebuild better-sqlite3` might be needed. Per MEMORY.md: Node-mode rebuild = `pnpm rebuild better-sqlite3`; this is Node-mode (tsx), not Electron.
4. **`db:new-migration` helper gotcha:** The script creates the `.sql` file but does NOT auto-update `EMBEDDED` in `migrations.rs`. It prints a reminder. For Phase G's smoke test, delete the placeholder file and skip the manifest edit — we're just testing the helper, not actually adding a migration.
5. **Schema-diff triage:** Compare Electron's data DB to Tauri's `data.db` only. Do not pass Electron's index DB into M2 schema diff; Tauri `index.db` work is M7. Any data DB divergence must be fixed or documented in the PR before shipping.
6. **PR title convention:** `m2: DB + schemas + migrations` — matches repo's conventional commit pattern.
7. **PR body includes test plan checklist:** Per repo's CLAUDE.md ship workflow, every PR needs a "Test plan" section with bulleted markdown checklist. Plan Step 19.4 provides the exact body; use it verbatim via HEREDOC.
8. **No merge, no force-push, no branch delete:** User's global CLAUDE.md forbids unprompted destructive ops. Push + open PR = done. Wait for user.
9. **Command-parity audit parsing:** Keep the parser simple and conservative. Literal string extraction is fine for M2. If a command cannot be classified confidently, fail and force a ledger entry instead of guessing.
10. **Updater state shape:** The hook expects `AppUpdateState`, not the old `{ available, latestVersion }` mock shape. Type the mock return explicitly so future renderer changes break tests.
11. **Native wrappers are not M8.0:** Do only the small no-op/bridge commands already used by the renderer. Quick-capture lifecycle, native context menus, notifications, deep links, and full shutdown orchestration stay in M8.0.

### Constraints

- **No new feature-domain behavior.** Phase G is tooling + acceptance plus the
  M2 review addenda. New commands are allowed only for shell-neutral wrappers
  already called by the renderer (`notify_flush_done`, optional
  `logging_forward`) and must not implement notes/tasks/calendar/etc. behavior.
  Do not add migrations or domain logic.
- **Bench mode:** 1000 rows is the spec's number. Do not run 10_000 (heavier bench is M7) or 100 (too small to be meaningful).
- **Commit granularity:** Task 16 = 1 commit, Task 17 = 1 commit, Task 18 = 1 commit, Task 19 (push + PR) = no new commit on M2 branch. Total: 3 commits in Phase G.

### Acceptance criteria (Phase G done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2

# Scripts exist
test -x apps/desktop-tauri/scripts/dev-reset.sh
test -f apps/desktop-tauri/scripts/new-migration.ts
test -f apps/desktop-tauri/scripts/schema-diff.ts
test -f apps/desktop-tauri/scripts/command-parity-audit.ts

# Package.json scripts registered
for script in dev:a dev:b db:new-migration db:schema-diff db:reset command:parity; do
  node -e "const p = require('./apps/desktop-tauri/package.json'); process.exit(p.scripts['$script'] ? 0 : 1)" || {
    echo "MISSING script: $script"
    exit 1
  }
done

# Port audit and Electron import cleanup
pnpm --filter @memry/desktop-tauri port:audit
! rg -n "electron-log/renderer|from 'electron'|from \"electron\"" apps/desktop-tauri/src -g '!*.test.*'

# Command parity and updater mock-name cleanup
pnpm --filter @memry/desktop-tauri command:parity
for cmd in updater_get_state updater_check_for_updates updater_download_update updater_quit_and_install; do
  rg -q "$cmd" apps/desktop-tauri/src/lib/ipc/mocks/updater.ts apps/desktop-tauri/src/lib/ipc/mocks/updater.test.ts || {
    echo "Missing updater mock command: $cmd"
    exit 1
  }
done
! rg -n "(^|[^[:alnum:]_])updater_(check|download|install)([^[:alnum:]_]|$)" \
  apps/desktop-tauri/src/hooks/use-app-updater.ts \
  apps/desktop-tauri/src/lib/ipc/mocks/updater.ts \
  apps/desktop-tauri/src/lib/ipc/mocks/updater.test.ts

# Flush bridge classified or implemented
rg -n "notify_flush_done" apps/desktop-tauri/src apps/desktop-tauri/src-tauri/src apps/desktop-tauri/scripts/command-parity-audit.ts

# Package residue count captured for PR ledger
rg -n '@memry/' apps/desktop-tauri/src apps/desktop-tauri/src-tauri | wc -l

# Bench binary exists + compiles
test -f apps/desktop-tauri/src-tauri/src/bin/bench_m2.rs
cd apps/desktop-tauri/src-tauri && cargo check --bin bench_m2 --features test-helpers

# Bench passes
cd apps/desktop-tauri/src-tauri && cargo run --release --bin bench_m2 --features test-helpers 2>&1 | tail -3
# Expect: output with p50 and assertion passing

# Full acceptance gate
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -3
# Expect: ≥ 20 tests passed

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri lint
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri command:parity

# Cold-start migration smoke
pnpm --filter @memry/desktop-tauri db:reset
# Then quickly boot dev and check migrations applied
# (Manual step — see Phase G Task 19.1)

# Required schema parity check: Electron data DB vs Tauri data.db
pnpm --filter @memry/desktop-tauri db:schema-diff <electron-data-db> <tauri-data.db>

# Commits for Phase G
git log --oneline | grep -cE 'm2\((devx|bench)\)'
# expect ≥ 3 (2 devx + 1 bench)

# Branch pushed
git ls-remote --heads origin m2/db-schemas-migrations | grep -q m2/db-schemas-migrations

# PR open
gh pr view m2/db-schemas-migrations --json number,title,state 2>/dev/null
# Expect: state OPEN, title "m2: DB + schemas + migrations"

# Electron untouched
git diff --name-only main..HEAD -- apps/desktop/ apps/sync-server/ packages/ | wc -l
# expect 0
```

### When done

Report:

```
Phase G complete — M2 shipped.
Tasks covered: 16, 17, 18, 19
Commits (Phase G): <N> (<first_hash>..<last_hash>)
Commits (M2 total): <total>
Rust tests: <total passed>
TS tests: <total passed>
Bench: p50 = <X>µs, p95 = <Y>µs (threshold 20000µs)

Dev tooling:
  - MEMRY_DEVICE=A/B profiles working
  - db:reset, db:new-migration, db:schema-diff scripts ready
  - command:parity script clean
  - bench_m2 binary in place for regression tracking

Parity hardening:
  - updater mock names aligned with renderer hook
  - notify_flush_done/logging/window-wrapper status: <implemented | classified>
  - command ledger: <0 unclassified | list>

Branch: m2/db-schemas-migrations pushed to origin
PR: <number> — <URL>

Schema-diff vs Electron data DB: <identical | N diffs documented in PR | blocked with reason>

M2 milestone: ready for user review and merge.
Next: M3 plan authoring — invoke superpowers:writing-plans with spec §M3.

Blockers: <none | list>
```

If acceptance fails at any check:
1. Do not push a broken branch.
2. Diagnose (cargo check error? typecheck error? bench p50 too high?).
3. Report finding + fix plan, wait for approval.

If the bench p50 exceeds 20ms:
1. Confirm `--release` flag was passed.
2. `PRAGMA index_list(tasks)` should show `idx_tasks_project`, `idx_tasks_completed`, etc. from migration 0001. If missing, migration didn't run or indexes got optimized out.
3. Try `cargo clean && cargo run --release --bin bench_m2 --features test-helpers` to force full rebuild.
4. If still failing, profile with `cargo flamegraph` or simpler: add per-iteration timings to isolate prepare vs query vs row-iter cost.
5. Report, wait for approval before shipping PR.

### Ready

1. Invoke `superpowers:using-superpowers`. Optionally `superpowers:finishing-a-development-branch` when reaching Task 19.
2. Read plan Tasks 16, 17, 18, 19 fully.
3. Run prerequisite verification.
4. Task 16: add 2 dev scripts → smoke with profile A/B → commit.
5. Task 17: 4 tool scripts + package.json updates + logger/audit cleanup + updater mock alignment + shell-neutral wrapper classification → smoke each → commit.
6. Task 18: bench binary → release run → assert pass → commit.
7. Task 19: full acceptance gate + required schema diff (no new commits; verify only) → push → open PR.

## PROMPT END
