# M1 Phase A — Tauri Scaffold

Temiz session prompt. Aşağıyı yeni Claude Code session'ında başlangıç mesajı olarak ver.

---

## PROMPT START

You are implementing **Phase A of Milestone M1** for Memry's Electron→Tauri migration. Read this entire prompt before starting.

### Context

**Repo:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk`
**Branch:** `spike/tauri-risk-discovery`
**Parent spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
**Implementation plan:** `docs/superpowers/plans/2026-04-24-m1-tauri-skeleton-and-renderer-port.md`

Memry is a desktop notes app migrating from Electron to Tauri 2.x. Electron codebase (`apps/desktop/`) is being frozen; new Tauri app (`apps/desktop-tauri/`) is being built from scratch. Pre-production — no users, no backward compat.

### Your scope

Execute **Tasks 1, 2, 3, 4** from the implementation plan. These cover:

- **Task 1:** Scaffold `apps/desktop-tauri/` directory + package.json + workspace integration
- **Task 2:** Rust backend scaffold (Cargo.toml, tauri.conf.json, capabilities, main.rs, lib.rs)
- **Task 3:** Vite + React 19 + Tailwind v4 config
- **Task 4:** TypeScript configs (tsconfig.json, tsconfig.node.json, tsconfig.web.json)

### Pre-flight

Before Task 1, run these and report results. If any fail, STOP and report to user — do not improvise:

```bash
rustc --version    # expect 1.95+
cargo --version
node --version     # expect v24.x
pnpm --version     # expect 10.x
git branch --show-current   # expect spike/tauri-risk-discovery
git status --short           # expect clean tree
```

### Methodology

1. **Invoke skills first:** Start every response by invoking `superpowers:using-superpowers`. If a skill matches the task, invoke it.
2. **Read the plan.** Before any step, read Tasks 1-4 from the plan file. Follow step commands **verbatim** — do not substitute.
3. **TDD where applicable:** Phase A is mostly scaffolding; unit tests don't apply to directory creation. Instead use **verification-before-completion** (superpowers:verification-before-completion skill). After every step that creates or modifies files, run the verification commands from the plan step. Do not mark a step complete until its verification passes.
4. **Commit per task:** Each of Tasks 1-4 ends with a commit. Follow the exact commit message from the plan.
5. **No scope creep:** Do NOT touch `apps/desktop/`, `apps/sync-server/`, `packages/`, or any file outside `apps/desktop-tauri/` and `pnpm-workspace.yaml`.

### Constraints

- **Coding style:** Prettier (single quotes, no semi, 100 char, no trailing comma). Named exports only (no default unless absolutely necessary). No `console.log` — use `createLogger('Scope')` pattern for any TS logger code.
- **Rust style:** rustfmt default. `cargo clippy -- -D warnings` must pass at end of Task 2.
- **No placeholders:** Every file must be complete. No `// TODO fill in later`.

### Acceptance criteria (Phase A done when all pass)

```bash
# From repo root
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk

# Directory structure exists
test -d apps/desktop-tauri/src-tauri/src/commands

# Workspace picks up the package
pnpm list -r --depth 0 | grep @memry/desktop-tauri

# Rust compiles clean
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy

# TypeScript config valid (will complain about missing src/ files — expected)
pnpm --filter @memry/desktop-tauri typecheck 2>&1 | grep -E '(error TS18003|No inputs were found)'
# exit code OK (expected "No inputs were found" error because src/ is empty)

# Commits landed
git log --oneline | grep "m1(scaffold)"   # at least 4 commits

# Electron is untouched
git diff --name-only main..HEAD -- apps/desktop/ | wc -l  # must be 0
```

### When done

Report this exact format to the user:

```
Phase A complete.
Tasks covered: 1, 2, 3, 4
Commits: <N> (<first_hash>..<last_hash>)
Verification:
  - pnpm list: @memry/desktop-tauri present
  - cargo check: clean
  - cargo clippy: clean (no warnings)
  - typecheck: expected "No inputs" error (empty src/)
  - Electron untouched: 0 files changed

Next: Phase B — prompts/m1-phase-b-electron-freeze.md
Blockers: <none | list>
```

If you hit an unexpected blocker:
1. Do not guess or improvise a fix.
2. Invoke `superpowers:systematic-debugging` if it's a bug.
3. Check spec Section 6.4 (Trip-wires) — did one fire?
4. Report findings and proposed fix to user; wait for approval.

### Ready

Begin by:
1. Invoke `superpowers:using-superpowers`.
2. Read `docs/superpowers/plans/2026-04-24-m1-tauri-skeleton-and-renderer-port.md` Tasks 1-4 fully.
3. Run pre-flight checks. Report results.
4. Start Task 1.

## PROMPT END
