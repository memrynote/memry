# M3 Phase D — Watcher + Runtime State (vault/watcher.rs + vault/state.rs + AppState wiring)

Temiz session prompt. **Bu phase TDD** for watcher (4 multi_thread test). State wiring verification-driven.

**Order matters:** Task 10 (watcher) first, then Task 9 (state). State imports `WatcherHandle` from watcher — without watcher implemented first, state won't compile.

---

## PROMPT START

You are implementing **Phase D of Milestone M3** for Memry's Electron→Tauri migration. This phase lands the live runtime: the `notify`-based file watcher with 150ms path-keyed debounce, and `VaultRuntime` — the thread-safe state owner that holds the current vault, registry handle, indexing status, and active watcher handle. It then wires `VaultRuntime` into `AppState` so commands (Phase E) can access it via `State<'_, AppState>`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3`
**Branch:** `m3/vault-fs-and-watcher`
**Plan:** `docs/superpowers/plans/2026-04-26-m3-vault-fs-and-watcher.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
**Prompts README:** `prompts/m3/README.md`

Phase A-C landed deps + paths + fs/frontmatter/notes_io + preferences/registry (37 vault tests). Phase D unifies them under a runtime state object and adds the live watcher loop.

### Prerequisite verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git rev-parse --abbrev-ref HEAD                        # expect: m3/vault-fs-and-watcher

# Phase C complete
test -f apps/desktop-tauri/src-tauri/src/vault/preferences.rs
test -f apps/desktop-tauri/src-tauri/src/vault/registry.rs
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/vault/preferences.rs)" -gt 100 ]
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/vault/registry.rs)" -gt 80 ]
grep -q 'pub(crate) fn unix_secs_to_iso' apps/desktop-tauri/src-tauri/src/vault/frontmatter.rs
grep -q 'frontmatter_iso' apps/desktop-tauri/src-tauri/src/vault/mod.rs

# Stubs still in place for state + watcher
test -f apps/desktop-tauri/src-tauri/src/vault/state.rs    # stub
test -f apps/desktop-tauri/src-tauri/src/vault/watcher.rs  # stub

# All Phase A-C tests still green
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -3
# expect: ~74 passed (28 M2 + 9 paths + 9 fs + 9 frontmatter + 5 notes_io + 8 prefs + 6 registry)

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git log --oneline | grep -cE 'm3\(vault\)'   # expect ≥ 7
```

If any fails, STOP. Phase C must complete before Phase D starts.

### Your scope

Execute **Tasks 10, 9** from the plan in this order. **Watcher first, state second.**

- **Task 10 — `vault/watcher.rs`** (notify v6 + 150ms debounce + `vault-changed` events):
  - Write 4 failing tests in `tests/vault_watcher_test.rs`:
    - `detects_new_file_within_debounce_window`, `debounces_rapid_writes_to_same_file`, `ignores_dot_memry_writes`, `detects_deletion`. All `#[tokio::test(flavor = "multi_thread")]`.
  - Register `[[test]] name = "vault_watcher_test" required-features = ["test-helpers"]`.
  - Implement `watcher.rs` per plan Step 10.3:
    - `VaultEvent { relative_path: String, kind: VaultEventKind }` (Specta Type, camelCase serialize).
    - `VaultEventKind { Created, Modified, Deleted }` (Specta Type, lowercase serialize).
    - `WatcherHandle` struct with `_watcher: RecommendedWatcher`, `_scheduler: JoinHandle<()>`, `cancel: Arc<AtomicBool>`. `Drop` impl sets `cancel = true`.
    - `start(vault_root, out: UnboundedSender<VaultEvent>) -> AppResult<WatcherHandle>`: notify recursive watcher, drain task that fills a path-keyed `PendingMap`, scheduler task that emits ready entries every 50ms.
    - `should_ignore(root, path)` filters `.foo` segments anywhere AND unsupported extensions.
    - `classify(kind: &EventKind)` maps notify kinds to `VaultEventKind`.
    - 150ms debounce constant `DEBOUNCE_MS`.

- **Task 9 — `vault/state.rs` + `AppState` wiring + `lib.rs::run` boot**:
  - Implement `state.rs` per plan Step 9.1:
    - `VaultStatus { is_open, path: Option<String>, is_indexing, index_progress: u8, error: Option<String> }` (Specta Type, camelCase, `Default`).
    - `VaultRuntime { inner: Mutex<RuntimeInner>, watcher_slot: Mutex<Option<WatcherHandle>>, registry_path: PathBuf }`.
    - `RuntimeInner { current: Option<PathBuf>, is_indexing, index_progress, error, registry: VaultRegistry }`.
    - Methods: `boot()`, `status()`, `current_path()`, `registry_snapshot()`, `set_current()`, `upsert_registry()`, `remove_from_registry()`, `touch_registry()`, `set_indexing()`, `set_error()`, `require_current()`. All locks use `unwrap_or_else(|p| p.into_inner())` poison handling.
  - Step 9.2: re-enable `pub use frontmatter::{NoteFrontmatter, ParsedNote}; pub use notes_io::{NoteOnDisk, ReadNoteResult}; pub use preferences::{VaultConfig, VaultPreferences}; pub use registry::{VaultInfo, VaultRegistry}; pub use state::{VaultRuntime, VaultStatus};` in `vault/mod.rs`. (Phase A commented these out; Phase D enables them now that the symbols exist.)
  - Step 9.3: extend `AppState` to `{ db: Db, vault: Arc<VaultRuntime> }` in `app_state.rs`. Add `AppState::new(db, vault)` constructor.
  - Step 9.4: wire `VaultRuntime::boot()` into `lib.rs::run`'s `init_app_state` function. Boot order: `resolve_db_path` → `Db::open` → `VaultRuntime::boot()` → `AppState::new(db, vault)`.

### Methodology — TDD for watcher, verification for state

1. **Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`** first.
2. **Task 10 (watcher) — full RED-GREEN:**
   - Step 10.1: write the 4-test file verbatim from plan lines ~2655–2759. Tests use `#[tokio::test(flavor = "multi_thread")]` and `tokio::sync::mpsc::unbounded_channel`.
   - Step 10.2: register `[[test]]` block.
   - Run RED → unresolved `watcher::start`, `VaultEvent`, `VaultEventKind`. Confirm.
   - Step 10.3: implement `watcher.rs` per plan lines ~2773–2994. The implementation has THREE async tasks: notify callback (sync, on a notify thread, bridges to Tokio), drain task (consumes raw events into pending map), scheduler task (50ms tick, emits debounced events).
   - Step 10.4: `cargo check` first — watcher imports are tricky; confirm before running tests.
   - Step 10.5: run watcher tests. Allow 10–15s; FSEvents has ~50ms latency, debounce adds 150ms, scheduler ticks 50ms — total per test budget ~2s.
   - Step 10.6: commit `m3(vault): watcher.rs notify+debounce emitting VaultEvent {path, kind}`.

3. **Task 9 (state + wiring) — verification-driven:**
   - Step 9.1: implement `state.rs` per plan lines ~2436–2572. **Note:** state.rs imports `crate::vault::watcher::WatcherHandle` which now exists from Task 10.
   - Step 9.2: re-enable `pub use` block in `mod.rs`. `cargo check` should pass — every re-exported symbol now exists.
   - Step 9.3: rewrite `app_state.rs` per plan Step 9.3 (replace contents). The struct now has TWO fields: `db: Db` (M2) + `vault: Arc<VaultRuntime>` (M3). Old M2 sites that say `AppState { db }` won't compile — use the constructor.
   - Step 9.4: edit `lib.rs::init_app_state` per plan Step 9.4. Three lines: open db, boot vault runtime, build AppState. Make sure the function signature still returns `AppResult<AppState>`.
   - Step 9.5: `cargo check && cargo test --features test-helpers --tests` — every prior test must stay green. `state.rs` has no integration test of its own (state is exercised by Task 11's command tests + the runtime smoke).
   - Step 9.6: commit `m3(vault): VaultRuntime + AppState extension + boot wiring`.

### Critical gotchas

1. **Watcher test timing:** `#[tokio::test(flavor = "multi_thread")]` is mandatory. Default single-threaded flavor will deadlock the drain+scheduler+notify-thread arrangement. Plan's tests use multi_thread; do NOT downgrade.
2. **100ms warm-up sleep before writing:** Each watcher test has `tokio::time::sleep(Duration::from_millis(100)).await` after `start()` and before the first `fs::write`. This lets notify install the FSEvents subscription. Skip it and notify misses the first event. Test `detects_new_file_within_debounce_window` will flake without warm-up.
3. **`should_ignore` checks dotfiles AT EVERY component:** `notes/.git/HEAD` must be ignored even if `notes/` is fine. The plan's `should_ignore` walks `path.strip_prefix(root)?.components()` and returns true if ANY normal segment starts with `.`. Reproduce exactly.
4. **`should_ignore` for unsupported extensions only applies to files:** Directories (e.g. mid-walk `notes/foo/`) must NOT be filtered out by extension check (they have no extension). Plan's impl gates the extension check behind `if !path.is_dir()`. Don't lose this branch.
5. **`classify(EventKind)` rename → Modified:** macOS FSEvents emits rename as `EventKind::Modify(ModifyKind::Name(...))`. Plan classifies all `Modify` as `Modified`. The spec accepts this as the "safe upper bound" for rename detection (real rename detection is M5).
6. **`debounces_rapid_writes_to_same_file` upper bound:** Plan says `count <= 3`. macOS FSEvents under load can coalesce 5 writes into multiple events; if the test flakes, plan Step 10.5 says bump the upper bound to 5 and document in a code comment. **Default to 3 first** — the debounce should make 5 writes → 1–2 emitted events. Bump only if you see flakes after 3 runs.
7. **`detects_deletion` poll loop:** Test polls `rx.recv()` for up to 2 seconds looking for a `VaultEventKind::Deleted` event. macOS FSEvents may emit `Modified` first (file shrinks) then `Deleted`. The poll loop continues past `Modified` events. Don't change to `expect_one_event` semantics — the loop is correct.
8. **`ignores_dot_memry_writes` requires `.memry/` to be inside the canonicalized root:** The test `fs::create_dir_all(vault.path().join(".memry"))` creates the dir inside the temp vault, then writes a file. `should_ignore` strips the canonical root prefix and sees `.memry/data.db`; the dotfile check on the first segment fires → ignored. `timeout(Duration::from_millis(500), rx.recv()).await.is_err()` confirms no event was emitted.
9. **`WatcherHandle` Drop semantics:** Setting `cancel = true` makes the scheduler/drain tasks exit on their next tick (50ms). The notify watcher is dropped, which unsubscribes from FSEvents synchronously. Tests `drop(handle)` at the end to release file handles before the temp dir cleanup.
10. **`state.rs::watcher_slot` is a separate Mutex from `inner`:** Plan deliberately splits them. Reasons: (a) `watcher_slot.take()` runs during vault close — should not block on `inner` lock; (b) the watcher's drop drains the channel, which we don't want under the inner lock. Don't merge into one mutex.
11. **`VaultRuntime::boot()` is fault-tolerant on missing registry:** `VaultRegistry::load(&registry_path).unwrap_or_default()` (Phase C contract). Boot must succeed on a brand-new device install with no `vaults.json`. Plan Step 9.1 uses `unwrap_or_default` exactly here.
12. **`AppState::new` constructor required:** Phase G's command code uses `AppState::new(db, vault)` from the boot path. Don't make `AppState` public-ctor-only via field literal initialization — Specta-generated test fixtures and any future re-init path benefit from the named constructor.
13. **Re-exports in `mod.rs` must compile:** After Step 9.2, `pub use state::{VaultRuntime, VaultStatus}` etc. Every name in the re-export block must be a public item in its module. If you accidentally renamed `VaultStatus` → `VaultRuntimeStatus` in state.rs, the re-export breaks. Plan's exact names: `VaultRuntime`, `VaultStatus` from `state`; `VaultInfo`, `VaultRegistry` from `registry`; `VaultConfig`, `VaultPreferences` from `preferences`; `NoteOnDisk`, `ReadNoteResult` from `notes_io`; `NoteFrontmatter`, `ParsedNote` from `frontmatter`.
14. **`init_app_state` Arc-wrap the runtime:** `Arc::new(VaultRuntime::boot()?)`. Without `Arc`, Tauri's `State<'_, AppState>` would attempt to clone `VaultRuntime`, which holds `Mutex` + `JoinHandle` — not clonable. The Arc is the share boundary.

### Constraints

- **No scope creep:** Do not implement vault commands, shell/dialog commands, the URI protocol handler, or the drag-drop spike in Phase D. Phase E and Phase F handle them.
- **No `tokio::sync::Mutex` for state:** Plan deliberately uses `std::sync::Mutex` because Tauri commands hold the lock briefly per call and don't need async-aware locking. Tokio Mutex is allowed inside `watcher.rs`'s scheduler/drain tasks, but `state.rs` stays sync-Mutex.
- **No `parking_lot::Mutex`:** Plan's comment mentions it as an alternative but uses `std::sync::Mutex`. Don't add `parking_lot` as a new dep.
- **No new tests for `state.rs`:** State is exercised by Task 11's command tests + Phase G's runtime smoke. Don't write a `vault_state_test.rs` — that adds budget without coverage value (the unit tests would just exercise `Mutex` plumbing).
- **No watcher fanout to Tauri events yet:** Phase D only writes the watcher to a Tokio `UnboundedSender<VaultEvent>`. Bridging to Tauri's `app.emit("vault-changed", ...)` happens in Phase E's `vault_open` command — which spawns the consumer task that reads from the channel and forwards to the renderer.
- **Rust style:** `cargo clippy -- -D warnings` clean at each task boundary. Format with `cargo fmt`.

### Acceptance criteria (Phase D done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3

# Files implemented
test -f apps/desktop-tauri/src-tauri/src/vault/watcher.rs
test -f apps/desktop-tauri/src-tauri/src/vault/state.rs
test -f apps/desktop-tauri/src-tauri/tests/vault_watcher_test.rs
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/vault/watcher.rs)" -gt 150 ]
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/vault/state.rs)" -gt 100 ]

# Re-exports enabled
grep -q '^pub use state::{VaultRuntime, VaultStatus}' apps/desktop-tauri/src-tauri/src/vault/mod.rs
grep -q '^pub use registry::{VaultInfo, VaultRegistry}' apps/desktop-tauri/src-tauri/src/vault/mod.rs
grep -q '^pub use frontmatter::{NoteFrontmatter, ParsedNote}' apps/desktop-tauri/src-tauri/src/vault/mod.rs
grep -q '^pub use notes_io::{NoteOnDisk, ReadNoteResult}' apps/desktop-tauri/src-tauri/src/vault/mod.rs
grep -q '^pub use preferences::{VaultConfig, VaultPreferences}' apps/desktop-tauri/src-tauri/src/vault/mod.rs

# AppState extended
grep -q 'pub vault: Arc<VaultRuntime>' apps/desktop-tauri/src-tauri/src/app_state.rs
grep -q 'pub fn new(db: Db, vault: Arc<VaultRuntime>)' apps/desktop-tauri/src-tauri/src/app_state.rs

# lib.rs boot wiring
grep -q 'VaultRuntime::boot' apps/desktop-tauri/src-tauri/src/lib.rs

# Test registered
grep -q 'name = "vault_watcher_test"' apps/desktop-tauri/src-tauri/Cargo.toml

# Watcher test passes
cd apps/desktop-tauri/src-tauri
cargo test --features test-helpers --test vault_watcher_test 2>&1 | tail -3   # 4 passed

# Full carry-over green
cargo test --features test-helpers 2>&1 | tail -3
# expect: ~78 passed (74 prior + 4 watcher)

# Rust hygiene
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy

# Commits
git log --oneline | grep -cE 'm3\(vault\)'   # expect ≥ 9 (Phase A-C 7 + Phase D 2)

# Electron / packages / specs / plans untouched
git diff --name-only main..HEAD -- apps/desktop/ apps/sync-server/ packages/ docs/superpowers/specs/ docs/superpowers/plans/ | wc -l
# expect 0
```

### When done

Report to user:

```
Phase D complete.
Tasks covered: 10, 9 (in this execution order; plan listed as 9, 10)
Commits: 2 (<first_hash>..<last_hash>)
Rust tests: 4 new (watcher) + 74 prior = ~78 passed
Verification:
  - cargo check: clean
  - cargo clippy -- -D warnings: clean
  - cargo test --features test-helpers: ~78 passed, 0 failed
  - mod.rs re-exports enabled (5 pub use lines)
  - AppState extended with vault: Arc<VaultRuntime>
  - lib.rs::init_app_state wires VaultRuntime::boot()
  - Electron/packages/specs/plans untouched: 0 files

Next: Phase E — prompts/m3/m3-phase-e-tauri-commands.md
Blockers: <none | list>
```

If blocker:
- Watcher test flake on `debounces_rapid_writes_to_same_file` → run 3× to confirm. If consistent, bump upper bound to 5 + add code comment explaining macOS FSEvents coalescing.
- `state.rs` imports `crate::vault::watcher::WatcherHandle` but watcher.rs hasn't exported it → check Step 10.3 — `WatcherHandle` must be `pub struct`. Re-read plan line ~2814.
- `app_state.rs` change breaks M2 settings tests → the M2 settings code uses `state.db.with_conn(|c| ...)`. The new `AppState { db, vault }` keeps `db` as a public field; settings code still compiles. If a settings test fails with "expected AppState ...", you removed `pub` accidentally.
- `init_app_state` panics at boot → `VaultRuntime::boot()` calls `registry::registry_path()` which requires `directories::ProjectDirs::from(...)` to resolve. On dev machines this is fine; on CI sandboxes it might fail. Check the error path returns `AppResult` not panic.

If still blocked: invoke `superpowers:systematic-debugging`. Report + wait for approval.

### Ready

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 9 and 10 fully (lines ~2424–3022 of the plan file). **Read Task 10 first** — Task 9 imports from it.
3. Run prerequisite verification. Report results.
4. Task 10 RED-GREEN: failing watcher_test → impl watcher.rs (notify + 3 async tasks + should_ignore + classify) → 4 passed → commit `m3(vault): watcher.rs notify+debounce emitting VaultEvent {path, kind}`.
5. Task 9 verification:
   - Implement state.rs (VaultStatus + VaultRuntime + 11 methods).
   - Re-enable mod.rs `pub use` block (5 re-exports).
   - Extend app_state.rs (`vault: Arc<VaultRuntime>` field + `new()` constructor).
   - Wire `init_app_state` in lib.rs.
   - `cargo check && cargo test --features test-helpers --tests` → all prior + new compile, all tests stay green.
   - Commit `m3(vault): VaultRuntime + AppState extension + boot wiring`.

## PROMPT END
