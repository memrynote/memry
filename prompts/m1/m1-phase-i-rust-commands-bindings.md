# M1 Phase I — Rust Commands Skeleton + Capability Check + Specta Bindings (TDD)

Temiz session prompt. Phase H tamamlandıktan sonra başlat. Bu phase TDD yoğun.

---

## PROMPT START

You are implementing **Phase I of Milestone M1** for Memry's Electron→Tauri migration. This phase adds the Rust `commands/` module (empty at M1), the capability sanity check script, and the tauri-specta binding generation pipeline.

### Context

**Repo:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk`
**Branch:** `spike/tauri-risk-discovery`
**Plan:** `docs/superpowers/plans/2026-04-24-m1-tauri-skeleton-and-renderer-port.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` Section 5.4 (Type generation) and Section 5.7 (Security conventions).

### Prerequisite

**Phase H complete.** Verify:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
pnpm --filter @memry/desktop-tauri port:audit 2>&1 | grep -q 'Total hits: 0'
pnpm --filter @memry/desktop-tauri typecheck
```

Both must succeed. If not, STOP.

### Your scope

Execute **Tasks 16, 17** from the plan:

- **Task 16:** Create `src-tauri/src/commands/mod.rs` (empty at M1), wire into `lib.rs`, write `scripts/capability-sanity-check.ts` with TDD
- **Task 17:** Add tauri-specta pipeline — `scripts/generate-bindings.ts`, `scripts/check-bindings.ts`, `src-tauri/src/bin/generate_bindings.rs`, initial `src/generated/bindings.ts` stub

### Methodology — TDD mandatory

**Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`** first.

**Task 16.1-16.3: Rust commands module (no TDD — structural code)**

1. Create `src-tauri/src/commands/mod.rs` per plan step 16.1.
2. Wire into `lib.rs` per step 16.2.
3. Verify `cargo check` passes.

No tests needed here — this is scaffolding for M2+ where real commands land.

**Task 16.4: Capability sanity check script with TDD**

This script is a critical guardrail — Spike 0 observation #11 showed that missing Tauri capability grants present as silent hangs, not error messages. The sanity check prevents that.

TDD workflow:

1. RED: Write `apps/desktop-tauri/scripts/capability-sanity-check.test.ts`:
   - Fixture 1: `tauri.conf.json` with no plugins → script exits 0
   - Fixture 2: `tauri.conf.json` with `plugins: {sql: {}}` + capability has `sql:default` → exits 0
   - Fixture 3: `tauri.conf.json` with `plugins: {sql: {}}` + capability missing `sql:*` grant → exits 1 with error message listing `sql` as missing
   - Fixture 4: capability has grants for plugin NOT in tauri.conf.json → script permits (over-granting is not a hang-risk)
   - Use temporary fixture files in `/tmp/` or fixture path passed as argument

2. Refactor the script from plan step 16.4 so its **core check logic** is a function accepting the parsed `conf` and `cap` objects, returning `{missing: string[]}`. The CLI entry just reads files, calls the function, handles exit code.

3. Run tests → FAIL
4. GREEN: Implement the script with the refactored structure
5. Run tests → PASS
6. Verify on real project data: `pnpm capability:check` → `✅ Capability sanity check passed`
7. Commit.

**Task 17: Specta binding pipeline**

1. Write `src/generated/bindings.ts` stub (step 17.1) — no TDD, it's a hand-written stub that will be overwritten.
2. Write `src-tauri/src/bin/generate_bindings.rs` (step 17.2) — no TDD, at M1 it's a no-op stub.
3. Add `[[bin]]` entry to `Cargo.toml` (step 17.3).

**For `scripts/generate-bindings.ts` and `scripts/check-bindings.ts` — TDD:**

1. RED: Write `scripts/generate-bindings.test.ts`:
   - Mock `execSync` — verify it's called with `cargo run --bin generate_bindings --quiet` and `cwd: src-tauri/`
   - Successful exec → script logs success and exits 0
   - Exec throws → script re-throws and exits 1

2. Similarly `scripts/check-bindings.test.ts`:
   - If `pnpm bindings:generate` produces no git diff → script exits 0 with success log
   - If diff exists → script exits 1 with "drift detected" message

3. Run tests → FAIL
4. GREEN: Implement both scripts per plan steps 17.4
5. Run tests → PASS
6. End-to-end smoke:
   - `pnpm bindings:generate` — should rebuild the stub, no changes
   - `pnpm bindings:check` — should exit 0 (no drift)
7. Commit.

### Constraints

- **Rust dependencies `specta` + `tauri-specta` are declared in Cargo.toml from Phase A** — verify they're present. If missing, add to Cargo.toml.
- **bindings.ts file commits are tracked.** Do NOT add `src/generated/` to `.gitignore`. Regeneration CI gate depends on git diff.
- **Cargo rebuild cost.** First run of `pnpm bindings:generate` will trigger a `cargo build --bin generate_bindings` compile — 30-60s. Subsequent runs cached.
- **Do not add real `#[tauri::command]` functions** at M1. The plan is explicit: `invoke_handler![]` stays empty until M2.
- **Script test env.** Vitest tests for scripts run under happy-dom (Phase D config). Node-specific modules like `fs` work fine because happy-dom only stubs DOM, not Node.

### Acceptance criteria (Phase I done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk

# Rust files
test -f apps/desktop-tauri/src-tauri/src/commands/mod.rs
test -f apps/desktop-tauri/src-tauri/src/bin/generate_bindings.rs
grep -q '\[\[bin\]\]' apps/desktop-tauri/src-tauri/Cargo.toml

# Scripts
test -f apps/desktop-tauri/scripts/capability-sanity-check.ts
test -f apps/desktop-tauri/scripts/capability-sanity-check.test.ts
test -f apps/desktop-tauri/scripts/generate-bindings.ts
test -f apps/desktop-tauri/scripts/generate-bindings.test.ts
test -f apps/desktop-tauri/scripts/check-bindings.ts
test -f apps/desktop-tauri/scripts/check-bindings.test.ts

# Generated file
test -f apps/desktop-tauri/src/generated/bindings.ts
grep -q '!! AUTO-GENERATED' apps/desktop-tauri/src/generated/bindings.ts

# Rust compiles + clippy clean
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy

# Scripts work end-to-end
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri bindings:generate
pnpm --filter @memry/desktop-tauri bindings:check
# All should exit 0

# Tests pass
pnpm --filter @memry/desktop-tauri test

# Typecheck clean
pnpm --filter @memry/desktop-tauri typecheck

# Commits
git log --oneline | grep -c "m1(backend)"   # ≥ 1 (Task 16)
git log --oneline | grep -c "m1(tooling)"   # ≥ 1 (Task 17)
```

### When done

Report:

```
Phase I complete.
Tasks covered: 16, 17
Commits: 2 (<first_hash>..<last_hash>)
Rust: commands/mod.rs scaffolded, bin/generate_bindings.rs stub compiled
Scripts + TDD:
  - capability-sanity-check: <N> tests
  - generate-bindings: <N> tests
  - check-bindings: <N> tests
Smoke:
  - cargo check/clippy clean
  - pnpm capability:check: pass
  - pnpm bindings:generate + check: no drift

Next: Phase J — prompts/m1-phase-j-smoke-visual-parity.md
Blockers: <none | list>
```

### Ready

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 16 and 17 fully.
3. Verify prerequisites.
4. Start with Task 16.1 (commands/mod.rs structural first), then TDD the capability check + binding scripts.

## PROMPT END
