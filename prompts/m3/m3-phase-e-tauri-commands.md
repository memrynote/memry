# M3 Phase E — Tauri Commands (vault.rs + shell.rs + dialog.rs + capabilities)

Temiz session prompt. Bu phase verification-driven (TDD değil — komutlar ince wrapper, test'ler Phase G'deki runtime e2e ve manuel smoke ile karşılanır).

---

## PROMPT START

You are implementing **Phase E of Milestone M3** for Memry's Electron→Tauri migration. This phase lands the full command surface that the renderer will call: 13 `vault_*` commands (open / close / status / current / get_all / switch / remove / get_config / update_config / list_notes / read_note / write_note / delete_note / reveal / reindex), 3 `shell_*` commands (open_url / open_path / reveal_in_finder), and 2 `dialog_*` commands (choose_folder / choose_files). Capabilities and the `tauri-plugin-dialog` registration round it out.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3`
**Branch:** `m3/vault-fs-and-watcher`
**Plan:** `docs/superpowers/plans/2026-04-26-m3-vault-fs-and-watcher.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
**Prompts README:** `prompts/m3/README.md`

Phase A-D landed deps + paths + fs/frontmatter/notes_io + preferences/registry + watcher + state/AppState/lib boot wiring (78 vault tests). Phase E exposes that runtime through Tauri commands. The commands themselves are thin async wrappers — the heavy lifting lives in `vault::*` modules. Phase E's correctness is exercised by Phase G's runtime e2e + manual smoke (no separate Rust integration tests in this phase).

### Prerequisite verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git rev-parse --abbrev-ref HEAD                        # expect: m3/vault-fs-and-watcher

# Phase D complete
test -f apps/desktop-tauri/src-tauri/src/vault/state.rs
test -f apps/desktop-tauri/src-tauri/src/vault/watcher.rs
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/vault/state.rs)" -gt 100 ]
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/vault/watcher.rs)" -gt 150 ]
grep -q 'pub vault: Arc<VaultRuntime>' apps/desktop-tauri/src-tauri/src/app_state.rs
grep -q 'VaultRuntime::boot' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q '^pub use state::{VaultRuntime, VaultStatus}' apps/desktop-tauri/src-tauri/src/vault/mod.rs

# All Phase A-D tests still green
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -3
# expect: ~78 passed (74 prior + 4 watcher)

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git log --oneline | grep -cE 'm3\(vault\)'   # expect ≥ 9

# Phase D's stubs (commands/shell.rs and commands/dialog.rs) — likely don't exist yet OR are M2 settings-only; check what's there
ls apps/desktop-tauri/src-tauri/src/commands/
# expect: mod.rs, settings.rs (from M2). Phase E will add vault.rs, shell.rs, dialog.rs

# Watcher_slot wiring spot-check — Task 11 vault_open uses it
grep -q 'watcher_slot' apps/desktop-tauri/src-tauri/src/vault/state.rs
```

If any fails, STOP. Phase D must complete before Phase E starts.

### Your scope

Execute **Tasks 11, 12** from the plan in this order.

- **Task 11 — `commands/vault.rs`** (13 vault commands + lib.rs wiring):
  - Create `commands/vault.rs` per plan Step 11.1 with the following Tauri commands. Each is `#[tauri::command]` + `#[specta::specta]` and returns `AppResult<...>`:
    - `vault_open(state, app, input: VaultOpenInput { path }) -> VaultOpenOutput { success, vault, error }` — opens a vault: validate dir, init `.memry/`, set indexing, stop prior watcher, set current, count notes, upsert + touch registry, start watcher, spawn `vault-changed` event forwarder, emit `vault-status-changed`.
    - `vault_close(state, app)` — drop watcher slot, set current `None`, set indexing false, emit status.
    - `vault_get_status(state) -> VaultStatus`.
    - `vault_get_current(state) -> VaultCurrent { path: Option<String> }`.
    - `vault_get_all(state) -> VaultGetAllOutput { vaults, currentVault }`.
    - `vault_switch(state, app, input: VaultPathInput)` — alias to `vault_open`.
    - `vault_remove(state, app, input: VaultPathInput)` — close-if-current, then `remove_from_registry`.
    - `vault_get_config(state) -> VaultConfig`.
    - `vault_update_config(state, input: VaultUpdateConfigInput)` — partial merge + `update_config`.
    - `vault_list_notes(state) -> VaultListNotesOutput { paths }` — `list_supported_files`, filter to `.md`/`.markdown` only.
    - `vault_read_note(state, input: VaultReadNoteInput { relativePath }) -> Option<ReadNoteResult>`.
    - `vault_write_note(state, input: VaultWriteNoteInput { relativePath, frontmatter, content }) -> NoteOnDisk`.
    - `vault_delete_note(state, input: VaultReadNoteInput)`.
    - `vault_reveal(state)` — calls `commands::shell::reveal_in_finder_inner(&current_path)`.
    - `vault_reindex(_state) -> VaultReindexOutput { success: true, files_indexed: 0, duration: 0, deferred_until: "M7" }`.
  - Update `commands/mod.rs` to declare `pub mod settings; pub mod vault; pub mod shell; pub mod dialog;`.
  - Register every command in `lib.rs::run`'s `.invoke_handler(tauri::generate_handler![...])` block (per plan Step 11.3).
  - Add minimal stubs to `commands/shell.rs` and `commands/dialog.rs` (signatures only, no real impl) so the macros find symbols and `cargo check` passes. Plan Step 11.4 supplies the exact stubs.

- **Task 12 — `commands/shell.rs` + `commands/dialog.rs` + capabilities**:
  - Replace `commands/shell.rs` stubs with real impl per plan Step 12.1:
    - `shell_open_url(app, url)` — reject non-http(s) schemes via `AppError::Validation`, then `app.shell().open(url, None)`.
    - `shell_open_path(app, path)` — reject non-absolute paths via `AppError::Validation`, reject non-existent via `AppError::NotFound`, then `app.shell().open(path, None)`.
    - `shell_reveal_in_finder(path)` — reject non-absolute, then call `reveal_in_finder_inner(path)`.
    - `pub(crate) fn reveal_in_finder_inner(path: &Path) -> AppResult<()>` — `#[cfg(target_os = "macos")]` runs `open -R <path>`; non-mac branch returns `AppError::Validation("reveal in finder is macOS-only in v1")`.
  - Replace `commands/dialog.rs` stubs with real impl per plan Step 12.2:
    - `dialog_choose_folder(app, title) -> Option<String>` — `app.dialog().file().pick_folder(...)` with `std::sync::mpsc` bridge.
    - `dialog_choose_files(app, title, filters) -> Vec<String>` — `pick_files(...)`.
  - Register `tauri-plugin-dialog` in `lib.rs::run` per plan Step 12.3 (`.plugin(tauri_plugin_dialog::init())`).
  - Update `capabilities/default.json` per plan Step 12.4 — add the dialog plugin's permission set (`dialog:default` or equivalent).

### Methodology — verification-driven

1. **Invoke `superpowers:using-superpowers`** first. TDD is not the methodology for this phase — the commands are thin wrappers and the underlying logic was tested in Phases A-D. Verification is via `cargo check`, `cargo clippy`, and Phase G's runtime smoke.
2. **Two commits — one per task.**
3. For Task 11:
   - Step 11.1: paste plan's `commands/vault.rs` verbatim (lines ~3035–3395). It has 13 commands + 1 helper (`now_iso`) + 6 input/output structs.
   - Step 11.2: rewrite `commands/mod.rs` to expose 4 modules.
   - Step 11.3: register 23 commands in `lib.rs::run`'s `invoke_handler`.
   - Step 11.4: stub `commands/shell.rs` and `commands/dialog.rs` per plan Step 11.4 (signatures + `Ok(())` bodies, plus `reveal_in_finder_inner` private helper).
   - Step 11.5: `cargo check && cargo clippy -- -D warnings` → both pass.
   - Step 11.6: commit `m3(commands): vault_* command surface (open/close/list/read/write/...) + shell/dialog stubs`.
4. For Task 12:
   - Step 12.1: replace `commands/shell.rs` per plan (lines ~3522–3590).
   - Step 12.2: replace `commands/dialog.rs` per plan (lines ~3593–3635).
   - Step 12.3: add `.plugin(tauri_plugin_dialog::init())` to the Builder chain in `lib.rs::run`.
   - Step 12.4: edit `capabilities/default.json` to grant dialog permissions.
   - Step 12.5: `cargo check && cargo clippy -- -D warnings && cargo test --features test-helpers` → all pass; no new tests.
   - Step 12.6: manual smoke — `pnpm dev`, click a button that triggers `dialog_choose_folder`, confirm picker opens. (Optional in Phase E; required in Phase G's manual smoke.)
   - Step 12.7: commit `m3(commands): shell + dialog real impl + tauri-plugin-dialog wired`.

### Critical gotchas

1. **`vault_open` flow ordering matters:**
   ```
   validate_dir → preferences::init_vault → set_indexing(true, 0)
   → drop_existing_watcher → set_current → count_notes → upsert+touch_registry
   → start_watcher → spawn_event_forwarder → set_indexing(false, 100)
   → emit vault-status-changed → return success
   ```
   Reordering breaks acceptance tests. Plan Step 11.1 lays this out exactly. Match step-by-step.
2. **Watcher slot lock scope:** Each `watcher_slot.lock()` runs in its own short block. **Never hold the lock across `await`** — Plan's impl uses `{ let mut slot = ...; *slot = Some(handle); }` then drops the guard before `tokio::spawn(...)`. Holding across the spawn would deadlock the next `vault_close` call.
3. **Event forwarder runs forever per vault open:** `tokio::spawn(async move { while let Some(event) = rx.recv().await { app_handle.emit(...); } })`. The receiver `rx` is held by the spawn task; when the watcher handle drops, `tx` drops, `rx.recv()` returns `None`, the loop exits. Don't add `if cancel { break }` — the channel close is the signal.
4. **`vault_switch` is just `vault_open`:** It exists for renderer ergonomics. Plan delegates it: `vault_switch(...) -> vault_open(state, app, VaultOpenInput { path: input.path }).await`. No additional logic.
5. **`vault_remove` close-if-current:** Compares `current.to_string_lossy()` to `input.path`. If match, `vault_close(state.clone(), app.clone()).await` first. **`State<'_, T>` is NOT clonable** — `state.clone()` would fail. The fix: pass the cloned `Arc<VaultRuntime>` in via the dereference, OR re-fetch state in vault_close. Plan's impl uses `state.clone()` because `State<'_, T>` does have a `clone()` for the `tauri::State` smart-pointer — verify this compiles. If it doesn't, refactor to `vault_close_inner(state.vault.clone(), app.clone())` taking `Arc<VaultRuntime>`.
6. **`vault_reindex` is a permanent stub for M3:** Returns `{ success: true, filesIndexed: 0, duration: 0, deferredUntil: "M7" }`. Phase G's `command:parity` audit must classify this as `deferred:M7`. Don't accidentally implement real reindex.
7. **`vault_reveal` reuses `shell::reveal_in_finder_inner`:** That helper is `pub(crate)` in `shell.rs` (Task 12). Phase E Task 11 stubs it returning `Ok(())` — Task 12 replaces it. The cross-module call is intentional; vault.rs depends on shell.rs.
8. **Stubs in Task 11 must match Task 12 signatures:** `shell_open_url(_url: String)` not `(_app, _url)`. `shell_open_path(_path: String)`. `shell_reveal_in_finder(_path: String)`. `dialog_choose_folder(_title: Option<String>)`. `dialog_choose_files(_title: Option<String>, _filters: Option<Vec<String>>)`. Matching signatures keep the `generate_handler!` registration stable across the two commits.
9. **`reveal_in_finder_inner` cfg-gating:** `#[cfg(target_os = "macos")]` for the `open -R` impl. The `#[cfg(not(target_os = "macos"))]` branch returns `Err(AppError::Validation(...))`. Don't omit the non-mac branch — `cargo check --target x86_64-unknown-linux-gnu` would fail in CI.
10. **`tauri-plugin-dialog` registration order:** Plan Step 12.3 adds `.plugin(tauri_plugin_dialog::init())` to the Builder chain. `tauri-plugin-shell` was already registered in M2. Order in the chain is: `default()` → `.plugin(shell)` → `.plugin(dialog)` → `.invoke_handler(...)` → `.setup(...)`. Standard Tauri 2 chain ordering.
11. **Capabilities for dialog:** Tauri 2 plugins need explicit capability grants. Edit `capabilities/default.json` to add the dialog permission set. Schema: `"dialog:default"` typically grants `pick_folder` and `pick_files`. Run `pnpm --filter @memry/desktop-tauri capability:check` to verify.
12. **`shell_open_url` URL allowlist:** Plan's impl rejects non-http(s) via prefix check. Don't expand to `mailto:`, `tel:`, etc. — that bypasses the URL escape guard. If renderer needs other schemes, M8 lifecycle layer will add explicit support.
13. **`dialog_choose_*` blocking bridge:** The dialog API is callback-based; plan uses `std::sync::mpsc::channel()` to bridge to async. The `tx.send(...)` in the callback is sync; `rx.recv()` blocks the async runtime briefly. Acceptable because the user is interacting with the OS picker — the runtime will wait. **Don't replace with `tokio::sync::mpsc`** — the dialog callback runs on a non-Tokio thread.
14. **`commands/mod.rs` must come BEFORE `lib.rs` references:** Without `pub mod vault;` in `commands/mod.rs`, the `commands::vault::*` paths in `lib.rs` won't resolve. Step 11.2 is structural; don't skip.
15. **No new tests for vault commands in this phase:** Phase G adds `m3-vault-smoke.spec.ts` against the real Tauri runtime. Adding Rust integration tests for `vault_open` would require booting Tauri inside a test, which is non-trivial. Plan defers that to runtime e2e.

### Constraints

- **No scope creep:** Do not implement `memry-file://` protocol, drag-drop spike, bindings regen, mock-swap, or runtime e2e in Phase E. Phase F + Phase G handle them.
- **No modifications to vault::* modules:** `vault::fs`, `vault::frontmatter`, `vault::notes_io`, `vault::preferences`, `vault::registry`, `vault::state`, `vault::watcher` are FROZEN by Phase E. Adding a new public function there is scope creep — Phase E should only call existing surface.
- **No new commands beyond M3 deliverables list:** 13 vault + 3 shell + 2 dialog = 18 commands. Don't add `vault_create_folder`, `vault_rename_note`, etc. — those are M5.
- **No mock changes:** `apps/desktop-tauri/src/lib/ipc/mocks/vault.ts` stays frozen in Phase E. Phase G trims it after bindings regen.
- **`cargo clippy -- -D warnings`** clean at each task boundary.
- **No Specta type registration here:** Phase G's `bin/generate_bindings.rs` adds the `.typ::<...>()` calls. Phase E commands use Specta proc-macros (`#[specta::specta]`) but don't touch the binding generator.

### Acceptance criteria (Phase E done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3

# Files implemented
test -f apps/desktop-tauri/src-tauri/src/commands/vault.rs
test -f apps/desktop-tauri/src-tauri/src/commands/shell.rs
test -f apps/desktop-tauri/src-tauri/src/commands/dialog.rs
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/commands/vault.rs)" -gt 250 ]
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/commands/shell.rs)" -gt 30 ]
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/commands/dialog.rs)" -gt 30 ]

# commands/mod.rs declares 4 modules
grep -q '^pub mod settings;' apps/desktop-tauri/src-tauri/src/commands/mod.rs
grep -q '^pub mod vault;' apps/desktop-tauri/src-tauri/src/commands/mod.rs
grep -q '^pub mod shell;' apps/desktop-tauri/src-tauri/src/commands/mod.rs
grep -q '^pub mod dialog;' apps/desktop-tauri/src-tauri/src/commands/mod.rs

# 18 commands registered in lib.rs invoke_handler (settings 3 + vault 15 + shell 3 + dialog 2 = 23)
grep -c 'commands::vault::vault_' apps/desktop-tauri/src-tauri/src/lib.rs   # expect ≥ 15
grep -c 'commands::shell::shell_' apps/desktop-tauri/src-tauri/src/lib.rs   # expect ≥ 3
grep -c 'commands::dialog::dialog_' apps/desktop-tauri/src-tauri/src/lib.rs # expect ≥ 2

# tauri-plugin-dialog registered
grep -q 'tauri_plugin_dialog::init' apps/desktop-tauri/src-tauri/src/lib.rs

# Capabilities updated
grep -q 'dialog' apps/desktop-tauri/src-tauri/capabilities/default.json

# Rust hygiene
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
pnpm --filter @memry/desktop-tauri capability:check

# All prior tests still green (no new tests in Phase E)
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -3
# expect: ~78 passed (no delta from Phase D)

# Commits
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git log --oneline | grep -cE 'm3\(commands\)'   # expect ≥ 2

# Electron / packages / specs / plans untouched
git diff --name-only main..HEAD -- apps/desktop/ apps/sync-server/ packages/ docs/superpowers/specs/ docs/superpowers/plans/ | wc -l
# expect 0
```

### When done

Report to user:

```
Phase E complete.
Tasks covered: 11, 12
Commits: 2 (<first_hash>..<last_hash>)
Rust tests: 0 new (verification-driven phase) — total still ~78 passed
Verification:
  - cargo check: clean
  - cargo clippy -- -D warnings: clean
  - cargo test --features test-helpers: 78 passed, 0 failed
  - capability:check: clean
  - 23 commands registered in lib.rs invoke_handler (15 vault + 3 shell + 2 dialog + 3 settings)
  - tauri-plugin-dialog wired
  - capabilities/default.json updated
  - Electron/packages/specs/plans untouched: 0 files

Next: Phase F — prompts/m3/m3-phase-f-protocol-and-dragdrop.md
Blockers: <none | list>
```

If blocker:
- `cargo check` complains "no function `state.clone()`" → `tauri::State<'_, T>` does have `Clone`; if your version doesn't, refactor `vault_remove` to call `vault_close_inner(Arc<VaultRuntime>, AppHandle)` instead of `vault_close(state, app)`.
- Specta complains about `frontmatter::NoteFrontmatter` → check that `vault/mod.rs` re-exports it (Phase D Step 9.2). Without the re-export, `commands::vault::vault.rs::use crate::vault::frontmatter::NoteFrontmatter;` works but `bindings.rs` Phase G `.typ::<vault::frontmatter::NoteFrontmatter>()` does too — both should work in parallel.
- `tauri::generate_handler!` complains about a missing command → check the macro list; you may have a typo. The list must EXACTLY match the function names in their respective modules.
- `capability:check` fails → the dialog permission identifier may have changed in the Tauri 2 plugin version. Check `apps/desktop-tauri/src-tauri/gen/schemas/desktop-schema.json` for the actual permission name.

If still blocked: invoke `superpowers:systematic-debugging`. Report + wait for approval.

### Ready

1. Invoke `superpowers:using-superpowers`.
2. Read plan Tasks 11, 12 fully (lines ~3024–3735 of the plan file).
3. Run prerequisite verification. Report results.
4. Task 11:
   - Paste `commands/vault.rs` verbatim from plan Step 11.1.
   - Update `commands/mod.rs`.
   - Register 23 commands in `lib.rs::run`.
   - Stub `commands/shell.rs` and `commands/dialog.rs` per Step 11.4.
   - `cargo check && cargo clippy -- -D warnings`.
   - Commit `m3(commands): vault_* command surface (open/close/list/read/write/...) + shell/dialog stubs`.
5. Task 12:
   - Replace `commands/shell.rs` with real impl.
   - Replace `commands/dialog.rs` with real impl.
   - Wire `tauri-plugin-dialog` in `lib.rs::run`.
   - Update `capabilities/default.json`.
   - `cargo check && cargo clippy -- -D warnings && cargo test --features test-helpers && capability:check`.
   - Commit `m3(commands): shell + dialog real impl + tauri-plugin-dialog wired`.

## PROMPT END
