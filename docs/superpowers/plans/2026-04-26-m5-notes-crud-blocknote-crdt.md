# M5 — Notes CRUD + BlockNote + CRDT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the M1 mock notes/CRDT/folder/property surface with real Rust commands backed by `yrs` (authoritative CRDT), `note_metadata`/`note_positions`/`property_definitions`/`folder_configs`/`tag_definitions` tables (already in M2/M3), the M3 vault FS, plus two new CRDT tables. Wire BlockNote in the renderer through `y-prosemirror` against a renderer shadow Y.Doc, with origin-tag echo prevention. Stand up the first real Tauri-runtime e2e lane and close the notes/folder/property/CRDT parity ledger.

**Architecture:** New `src-tauri/src/crdt/` module owns a `DocStore` (`tokio::sync::Mutex<HashMap<NoteId, Doc>>` behind `Arc`) with `apply.rs` (decode v1 update → apply with origin tag), `snapshot.rs` (`encode_state_as_update_v1` on demand), `compaction.rs` (after N updates, write snapshot + drop old updates inside one DB tx), and `wire.rs` (binary wire helpers). The existing `src-tauri/src/db/` skeletons (`note_metadata`, `note_positions`, `notes_cache`, `folder_configs`, `tag_definitions`) get fleshed out with full CRUD; new `db/property_definitions.rs` and `db/crdt_updates.rs` + `db/crdt_snapshots.rs` modules are added. `commands/notes.rs`, `commands/folders.rs`, `commands/properties.rs`, `commands/crdt.rs`, and `commands/devtools.rs` ship the renderer surface. Renderer adds `lib/crdt/yjs-tauri-provider.ts` (subscribe + apply with origin guard) plus `lib/crdt/origin-tags.ts`; BlockNote keeps its existing config but now binds to the shadow Y.Doc with XmlFragment name `"prosemirror"` (matching Electron's `CRDT_FRAGMENT_NAME`). Mock IPC routes for notes/folders/properties/positions/links/CRDT are deleted; export/PDF/HTML/versions/import/attachments-upload/attachments-download keep mocks with explicit `deferred:M6`/`deferred:M7`/`deferred:M8` ledger entries. Runtime e2e harness uses `tauri-driver` + `webdriverio` driving the real packaged app.

**Tech Stack:** Tauri 2.10, Rust 1.95, yrs 0.21 (already declared in `Cargo.toml`), tokio sync (already `tokio = "full"`), lru 0.12 (snapshot LRU cache), once_cell, BlockNote 0.39 (renderer, already installed), y-prosemirror (renderer, already installed), Yjs 13.6 (renderer, already installed), tauri-driver 0.1 (dev-only, runtime e2e), webdriverio 9 (dev-only), Vitest, Playwright WebKit.

**Parent spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` (§4 M5, §2 CRDT ownership, §5 cross-cutting conventions)

**Predecessor plan:** `docs/superpowers/plans/2026-04-26-m4-crypto-keychain-auth.md` must be merged before M5 starts.

---

## Pre-flight Checks (do these before Task 1)

- [ ] M4 PR merged to `main`: `git log --oneline main | head -10` shows the `m4(*)` series ending with `m4(build): exclude dev-only bins from tauri bundle`.
- [ ] Rust toolchain: `rustc --version` returns 1.95+.
- [ ] Node 24.x active: `node --version` returns v24.x.
- [ ] pnpm 10.x active: `pnpm --version` returns 10.x.
- [ ] Baseline green on `main`:

```bash
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
pnpm --filter @memry/desktop-tauri cargo:test
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri test:e2e
```

Expected: every command exits 0. If `bindings:check` is dirty, regenerate as a separate M4-cleanup commit before starting M5.

- [ ] Vault FS smoke (M3 lives): `pnpm --filter @memry/desktop-tauri dev` opens the app, `vault_open` succeeds against `~/memry-test-vault-m3`, and the renderer notes-tree populates.

- [ ] M4 auth smoke: signing into staging from the running app caches the master key in keychain; `auth_status` returns `Unlocked`.

- [ ] Create a worktree for M5 isolation (per `~/.claude/projects/.../memory/feedback_worktree.md`):

```bash
git worktree add ../spike-tauri-m5 -b m5/notes-crud-blocknote-crdt main
cd ../spike-tauri-m5
```

From this point, every path is relative to `../spike-tauri-m5`.

- [ ] Reserve a fresh test vault for M5 runtime e2e and concurrent-edit tests:

```bash
mkdir -p ~/memry-test-vault-m5/notes ~/memry-test-vault-m5/journal ~/memry-test-vault-m5/attachments
mkdir -p ~/memry-test-vault-m5-A/notes ~/memry-test-vault-m5-B/notes
```

- [ ] Confirm the existing M3 watcher does **not** silently fire on `.memry/` writes. Add a one-off check in Task 10 if it does.

- [ ] Capture current `command:parity` output as the M4 baseline ledger snapshot:

```bash
pnpm --filter @memry/desktop-tauri command:parity > /tmp/m4-parity-baseline.txt
```

The carry-forward for the M5 PR body compares against this snapshot.

---

## M5 Decisions And Assumptions

These commit choices made during plan-writing. Override only via PR-body decision-record.

- **CRDT crate:** `yrs = "0.21"` (already declared, compile-verified since M1). Wire format = v1 (`encode_update_v1` / `decode_update_v1` / `encode_state_as_update_v1` / `encode_state_vector_v1`). XmlFragment name `"prosemirror"` to keep byte-compatibility with Electron's existing `CRDT_FRAGMENT_NAME`.
- **DocStore concurrency:** `Arc<tokio::sync::Mutex<HashMap<NoteId, yrs::Doc>>>`. `tokio::sync::Mutex` (not `parking_lot`) so `crdt_apply_update` can `.await` while the lock is held without blocking the runtime. M5 ships single-process — no cross-process contention to worry about.
- **Snapshot compaction threshold:** 100 updates per note. Configurable via `CRDT_COMPACT_THRESHOLD` env var for tests; production default = 100.
- **Loop prevention:** Origin tag is a `u32` derived from `MEMRY_DEVICE` env var (or `process::id()` fallback). Tag travels in the `crdt-update` event payload; renderer drops echoes whose origin matches its own client ID. Yjs natural idempotence is the second line of defense (S2 obs #9).
- **Binary IPC:** `crdt_apply_update` accepts an inline `Vec<u8>` argument up to 64 KB; larger updates use the renderer-side chunking helper (`splitUpdateForChannel`) and call `crdt_apply_update_chunk` instead. `crdt_get_snapshot` and `crdt_get_state_vector` return `tauri::ipc::Response::new(Vec<u8>)` to bypass JSON-array serialization (S3 obs #4). All wire byte arrays are `Vec<u8>` on Rust side, `Uint8Array` on TS side; do not let `serde` re-serialize.
- **Note storage model:** Markdown body lives in vault FS at `<vault>/<path>` (M3 owns this). `note_metadata` row holds id/title/path/emoji/timestamps + sync metadata. Y.Doc is the runtime authoritative state during editor sessions; on every successful commit we (a) write markdown to disk and (b) append the new Y update to `crdt_updates` for sync replication. On note close we run compaction.
- **MD→Yjs conversion:** Lazy on first `crdt_get_or_init_doc(noteId)` call. If the note has zero `crdt_updates` rows and zero snapshot, parse the markdown body into a BlockNote-compatible Y.XmlFragment and seed the doc; record the seed update as the first row in `crdt_updates`. Idempotent — re-running `get_or_init` returns the existing doc.
- **Devtools:** `devtools_reset_db`, `devtools_seed_vault`, `devtools_open_test_vault` are gated by `#[cfg(any(debug_assertions, feature = "test-helpers"))]` and registered in a separate `capabilities/dev.json` capability file scoped to the dev window only. Production bundles compile them out.
- **Wiki-link resolution:** `notes_resolve_by_title` and `notes_preview_by_title` use SQL `LIKE` against `note_metadata.title` (case-insensitive `COLLATE NOCASE`). FTS upgrade is M7 — leave a `TODO(M7)` comment plus a deferred ledger row.
- **Attachments in M5:** Local-only metadata (record `note_metadata.attachment_id`/`attachment_references`, list, get bytes via `memry-file://`). `notes_upload_attachment` and `notes_delete_attachment` graduate to mock-with-`deferred:M6` markers. Real R2 upload/download is M6.
- **Export/PDF/HTML/versions/import:** Mock-only for M5 with `deferred:M8.*` markers. No Rust impl.
- **Runtime e2e harness:** `tauri-driver` + `webdriverio` running against the bundled app. Test vault path = `$TMPDIR/memry-e2e-<uuid>` per spec to avoid stomping the dev vault. Two-device tests spawn two `tauri-driver` instances with `MEMRY_DEVICE=A` and `MEMRY_DEVICE=B`.
- **Single `Mutex<Connection>` for `data.db`:** Carried from M2 unchanged. If contention shows up under runtime e2e, escalate to a pool in a follow-up — do not change in M5.
- **Migration numbering:** New M5 migrations land as `0029_crdt_updates.sql` and `0030_crdt_snapshots.sql`. Hand-written per `MEMORY.md` "Migrations are hand-written since 0020" rule.
- **Tauri command names** (Electron channel → snake_case Tauri command):
  - `notes:create` → `notes_create`
  - `notes:get-by-path` → `notes_get_by_path`
  - `notes:list` → `notes_list`
  - `notes:list-by-folder` → `notes_list_by_folder`
  - `notes:rename` → `notes_rename`
  - `notes:move` → `notes_move`
  - `notes:exists` → `notes_exists`
  - `notes:get-folders` → `notes_get_folders`
  - `notes:create-folder` → `notes_create_folder`
  - `notes:rename-folder` → `notes_rename_folder`
  - `notes:delete-folder` → `notes_delete_folder`
  - `notes:get-property-definitions` → `notes_get_property_definitions`
  - `notes:create-property-definition` → `notes_create_property_definition`
  - `notes:update-property-definition` → `notes_update_property_definition`
  - `notes:ensure-property-definition` → `notes_ensure_property_definition`
  - `notes:add-property-option` → `notes_add_property_option`
  - `notes:add-status-option` → `notes_add_status_option`
  - `notes:remove-property-option` → `notes_remove_property_option`
  - `notes:rename-property-option` → `notes_rename_property_option`
  - `notes:update-option-color` → `notes_update_option_color`
  - `notes:delete-property-definition` → `notes_delete_property_definition`
  - `notes:get-positions` → `notes_get_positions`
  - `notes:get-all-positions` → `notes_get_all_positions`
  - `notes:reorder` → `notes_reorder`
  - `notes:get-tags` → `notes_get_tags`
  - `notes:get-links` → `notes_get_links`
  - `notes:resolve-by-title` → `notes_resolve_by_title`
  - `notes:preview-by-title` → `notes_preview_by_title`
  - `notes:set-local-only` → `notes_set_local_only`
  - `notes:get-local-only-count` → `notes_get_local_only_count`
  - `notes:get-folder-config` → `notes_get_folder_config`
  - `notes:set-folder-config` → `notes_set_folder_config`
  - `notes:get-folder-template` → `notes_get_folder_template`
  - `crdt:open-doc` → `crdt_open_doc`
  - `crdt:close-doc` → `crdt_close_doc`
  - `crdt:apply-update` → `crdt_apply_update`
  - `crdt:sync-step-1` → `crdt_sync_step_1` (returns `{ diff, stateVector }`)
  - `crdt:sync-step-2` → `crdt_sync_step_2`
  - new: `crdt_get_snapshot`, `crdt_get_state_vector`, `crdt_get_or_init_doc`
- **Deferred ledger graduations:** see "Carry-Forward Bookkeeping" chunk for the exact graduation list.

---

## File Structure

Files created or modified in M5:

```text
apps/desktop-tauri/
├── src-tauri/
│   ├── Cargo.toml                                Task 1 (deps: lru, once_cell)
│   ├── tauri.conf.json                           Task 53 (dev-window if needed)
│   ├── capabilities/
│   │   ├── default.json                          Task 47 (notes/folder/property/CRDT command grants)
│   │   └── dev.json                              Task 53 (new — devtools_* under #[cfg])
│   ├── migrations/
│   │   ├── 0029_crdt_updates.sql                 Task 11 (new)
│   │   └── 0030_crdt_snapshots.sql               Task 12 (new)
│   └── src/
│       ├── lib.rs                                Tasks 1, 47, 53 (register handlers + capabilities)
│       ├── error.rs                              Task 2 (Crdt + From<yrs> variants)
│       ├── app_state.rs                          Task 3 (add CrdtRuntime field)
│       │
│       ├── crdt/
│       │   ├── mod.rs                            Task 3 (new — re-exports + CrdtRuntime)
│       │   ├── docstore.rs                       Task 4 (new — DocStore impl)
│       │   ├── apply.rs                          Task 5 (new — decode + apply)
│       │   ├── snapshot.rs                       Task 6 (new — encode_state_as_update_v1)
│       │   ├── state_vector.rs                   Task 7 (new — encode_state_vector_v1)
│       │   ├── compaction.rs                     Task 8 (new — collapse + drop old updates)
│       │   ├── wire.rs                           Task 9 (new — bytes helpers + origin tags)
│       │   ├── seed.rs                           Task 51 (new — MD → Y.XmlFragment seed)
│       │   └── md_to_yjs.rs                      Task 50 (new — markdown → BlockNote Y.XmlFragment)
│       │
│       ├── db/
│       │   ├── mod.rs                            Task 14 (re-exports for new modules)
│       │   ├── note_metadata.rs                  Task 15 (flesh out — list/get_by_path/rename/move/upsert/soft_delete)
│       │   ├── note_positions.rs                 Task 16 (flesh out — get_for_folder/get_all/reorder)
│       │   ├── notes_cache.rs                    Task 17 (flesh out — refresh from metadata + body)
│       │   ├── folder_configs.rs                 Task 18 (flesh out — get/set/template inheritance)
│       │   ├── tag_definitions.rs                Task 19 (flesh out — list/upsert/aggregate counts)
│       │   ├── property_definitions.rs           Task 20 (new — full CRUD + options/status mutations)
│       │   ├── crdt_updates.rs                   Task 21 (new — append/list/drop_below_seq)
│       │   └── crdt_snapshots.rs                 Task 22 (new — upsert/get_latest)
│       │
│       └── commands/
│           ├── mod.rs                            Task 47 (register notes/folders/properties/crdt/devtools)
│           ├── notes.rs                          Tasks 23–32 (new)
│           ├── folders.rs                        Tasks 33–35 (new)
│           ├── properties.rs                     Tasks 36–41 (new)
│           ├── crdt.rs                           Tasks 42–46 (new)
│           ├── devtools.rs                       Task 53 (new — dev-only)
│           └── stubs_m6_m7_m8.rs                 Task 52 (new — deferred mocks behind cfg)
│
├── src/
│   ├── lib/
│   │   ├── crdt/
│   │   │   ├── yjs-tauri-provider.ts             Task 54 (new — subscribe + apply + origin guard)
│   │   │   ├── origin-tags.ts                    Task 55 (new — tag generation + comparison)
│   │   │   └── md-to-yjs.ts                      Task 56 (new — JS-side MD→Yjs for tests/seeds)
│   │   ├── ipc/
│   │   │   ├── invoke.ts                         Task 57 (graduate notes/folders/properties/CRDT)
│   │   │   ├── channel.ts                        Task 58 (new — Channel<u8> + Response<Vec<u8>> helpers)
│   │   │   └── mocks/
│   │   │       ├── notes.ts                      Task 57 (delete; replaced with deferred-only stubs)
│   │   │       ├── folders.ts                    Task 57 (delete keys covered; keep deferred export/version)
│   │   │       ├── properties.ts                 Task 57 (delete; covered by real Rust)
│   │   │       └── stubs/
│   │   │           ├── attachments.ts            Task 59 (new — deferred:M6)
│   │   │           ├── export.ts                 Task 59 (new — deferred:M8)
│   │   │           ├── versions.ts               Task 59 (new — deferred:M8)
│   │   │           └── import.ts                 Task 59 (new — deferred:M8)
│   │   └── logger.ts                             Task 60 (replace electron-log import)
│   ├── features/
│   │   └── notes/
│   │       ├── editor/
│   │       │   ├── BlockNoteEditor.tsx           Task 61 (wire shadow Y.Doc + provider)
│   │       │   └── useNoteCrdt.ts                Task 62 (new — hook combining open/close/apply)
│   │       └── notes-service.ts                  Task 63 (no-op if forwarder already real; verify imports)
│   ├── generated/
│   │   └── bindings.ts                           Tasks 47, regenerated each chunk
│   └── contracts/                                Task 64 (rolling extraction)
│       ├── notes.ts                              Task 64 (rehome from @memry/contracts)
│       ├── crdt.ts                               Task 64 (rehome ipc-crdt.ts here)
│       └── folders.ts                            Task 64 (rehome folder + property types)
│
├── e2e/
│   ├── playwright.config.ts                      Task 65 (add runtime project)
│   ├── runtime/
│   │   ├── runtime.config.ts                     Task 66 (new — tauri-driver wiring)
│   │   ├── helpers/
│   │   │   ├── driver.ts                         Task 67 (new — start/stop tauri-driver)
│   │   │   ├── vault.ts                          Task 67 (new — fresh test vault per spec)
│   │   │   └── auth.ts                           Task 67 (new — devtools-backed unlock)
│   │   └── specs/
│   │       ├── typing.spec.ts                    Task 68 (S1 Test 1: 500-char p95)
│   │       ├── concurrent-edit.spec.ts           Task 69 (S2 Test 5d reproduced)
│   │       ├── persistence.spec.ts               Task 70 (close/reopen)
│   │       ├── undo-redo.spec.ts                 Task 71 (10-op chain)
│   │       ├── slash-menu.spec.ts                Task 72 (slash + table + code + link)
│   │       └── manual-paste.spec.ts              Task 73 (DOM paste; clipboard checklist)
│   └── specs/
│       └── notes.spec.ts                         Task 74 (mock-lane regression update)
│
└── src-tauri/
    └── tests/
        ├── crdt_docstore_test.rs                 Task 4 (new)
        ├── crdt_apply_test.rs                    Task 5 (new)
        ├── crdt_snapshot_test.rs                 Task 6 (new)
        ├── crdt_state_vector_test.rs             Task 7 (new)
        ├── crdt_compaction_test.rs               Task 8 (new — covers acceptance: 100 → snapshot)
        ├── crdt_wire_test.rs                     Task 9 (new)
        ├── crdt_seed_test.rs                     Task 51 (new)
        ├── crdt_md_to_yjs_test.rs                Task 50 (new)
        ├── db_note_metadata_test.rs              Task 15 (new)
        ├── db_note_positions_test.rs             Task 16 (new)
        ├── db_notes_cache_test.rs                Task 17 (new)
        ├── db_folder_configs_test.rs             Task 18 (new)
        ├── db_tag_definitions_test.rs            Task 19 (new)
        ├── db_property_definitions_test.rs       Task 20 (new)
        ├── db_crdt_updates_test.rs               Task 21 (new)
        ├── db_crdt_snapshots_test.rs             Task 22 (new)
        ├── commands_notes_test.rs                Task 32 (new)
        ├── commands_folders_test.rs              Task 35 (new)
        ├── commands_properties_test.rs           Task 41 (new)
        ├── commands_crdt_test.rs                 Task 46 (new)
        └── commands_devtools_test.rs             Task 53 (new — only under cfg)
```

---

> Tasks below are grouped into chunks. Each chunk produces a green `cargo:test` and `pnpm test` slice; commits are atomic per task. After every chunk, regenerate bindings, run `command:parity`, and check the renderer mock-lane is still green before moving on.

---

## Chunk 1 — yrs CRDT Foundation

Goal: stand up the Rust CRDT core (DocStore + apply + snapshot + state vector + compaction + wire helpers) with full unit coverage **before** any command exposes it. Acceptance proof at end of chunk: `cargo test --test 'crdt_*'` passes ≥10 tests; `cargo:clippy -- -D warnings` clean.

### Task 1: Add `lru` + `once_cell` dependencies

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml`

- [ ] **Step 1.1: Inspect current `[dependencies]`** for the M5-relevant slot

```bash
grep -nE '^(yrs|tokio|rusqlite|tracing)' apps/desktop-tauri/src-tauri/Cargo.toml
```

Expected: `yrs = "0.21"` already present. Confirms M1 declared it.

- [ ] **Step 1.2: Append M5 deps**

Edit `apps/desktop-tauri/src-tauri/Cargo.toml`. Locate the `# Crypto + auth + keychain (M4)` block and add directly after it:

```toml
# CRDT (M5)
lru = "0.12"
once_cell = "1.20"
```

`lru` powers the snapshot-readback cache for `crdt_get_snapshot` (avoids re-encoding on every renderer reconnect). `once_cell` provides `Lazy<u32>` for the per-process origin tag.

- [ ] **Step 1.3: Verify lockfile updates and compiles**

```bash
cd apps/desktop-tauri/src-tauri && cargo check
```

Expected: `Finished `dev` profile`. New deps declared but unused; no warnings.

- [ ] **Step 1.4: Commit**

```bash
git add apps/desktop-tauri/src-tauri/Cargo.toml apps/desktop-tauri/src-tauri/Cargo.lock
git commit -m "m5(deps): add lru and once_cell for CRDT layer"
```

---

### Task 2: Extend `AppError` with `Crdt` variant + `From<yrs>` impls

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/error.rs`

- [ ] **Step 2.1: Write the failing test**

Create `apps/desktop-tauri/src-tauri/tests/error_crdt_test.rs`:

```rust
use memry_desktop_tauri_lib::error::AppError;

#[test]
fn crdt_variant_serializes() {
    let err = AppError::Crdt("bad update bytes".to_string());
    let json = serde_json::to_string(&err).unwrap();
    assert!(json.contains("\"kind\":\"Crdt\""));
    assert!(json.contains("\"message\":\"bad update bytes\""));
}

#[test]
fn crdt_display_message() {
    let err = AppError::Crdt("bad update bytes".to_string());
    assert_eq!(err.to_string(), "crdt error: bad update bytes");
}
```

- [ ] **Step 2.2: Run — expect FAIL**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test error_crdt_test
```

Expected: `error[E0599]` — variant `Crdt` not found.

- [ ] **Step 2.3: Add the variant**

Edit `apps/desktop-tauri/src-tauri/src/error.rs`, insert before `#[error("internal error: {0}")]`:

```rust
    #[error("crdt error: {0}")]
    Crdt(String),
```

Add the `From<yrs::error::Error>` impl after the `From<reqwest::Error>` block:

```rust
impl From<yrs::error::Error> for AppError {
    fn from(err: yrs::error::Error) -> Self {
        AppError::Crdt(err.to_string())
    }
}

impl From<yrs::encoding::read::Error> for AppError {
    fn from(err: yrs::encoding::read::Error) -> Self {
        AppError::Crdt(format!("decode: {err}"))
    }
}
```

- [ ] **Step 2.4: Run — expect PASS**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test error_crdt_test
```

Expected: 2 tests passing.

- [ ] **Step 2.5: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/error.rs apps/desktop-tauri/src-tauri/tests/error_crdt_test.rs
git commit -m "m5(error): add Crdt variant and From impls for yrs"
```

---

### Task 3: Add `CrdtRuntime` + wire it into `AppState`

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/crdt/mod.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/app_state.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`

- [ ] **Step 3.1: Write the failing test**

Create `apps/desktop-tauri/src-tauri/tests/crdt_runtime_test.rs`:

```rust
use memry_desktop_tauri_lib::crdt::CrdtRuntime;

#[tokio::test]
async fn runtime_starts_empty() {
    let runtime = CrdtRuntime::new();
    assert_eq!(runtime.open_doc_count().await, 0);
}

#[tokio::test]
async fn origin_tag_is_stable_across_calls() {
    let a = memry_desktop_tauri_lib::crdt::origin_tag();
    let b = memry_desktop_tauri_lib::crdt::origin_tag();
    assert_eq!(a, b);
    assert_ne!(a, 0);
}
```

- [ ] **Step 3.2: Run — expect FAIL**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test crdt_runtime_test
```

Expected: `error[E0432]` — module `crdt` does not exist.

- [ ] **Step 3.3: Create `crdt/mod.rs` skeleton**

```rust
//! CRDT runtime — yrs-backed authoritative Y.Docs keyed by note id.

mod docstore;

pub use docstore::DocStore;

use once_cell::sync::Lazy;
use std::sync::Arc;

/// Per-process origin tag. Used to stamp `crdt-update` events so the renderer
/// can drop echoes from its own writes (defense-in-depth on top of Yjs natural
/// idempotence — see Spike S2 obs #9).
static ORIGIN_TAG: Lazy<u32> = Lazy::new(|| {
    std::env::var("MEMRY_ORIGIN_TAG")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or_else(|| {
            // Mix process id with a startup nanosecond for non-zero,
            // non-trivial-collision tags across same-host devices.
            let pid = std::process::id();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0);
            pid.wrapping_mul(1_000_003).wrapping_add(nanos) | 1
        })
});

pub fn origin_tag() -> u32 {
    *ORIGIN_TAG
}

pub struct CrdtRuntime {
    docs: DocStore,
}

impl CrdtRuntime {
    pub fn new() -> Self {
        Self { docs: DocStore::new() }
    }

    pub fn docs(&self) -> &DocStore {
        &self.docs
    }

    pub async fn open_doc_count(&self) -> usize {
        self.docs.open_count().await
    }
}

impl Default for CrdtRuntime {
    fn default() -> Self {
        Self::new()
    }
}

pub type SharedCrdt = Arc<CrdtRuntime>;
```

- [ ] **Step 3.4: Stub `crdt/docstore.rs`**

```rust
//! In-memory store of open Y.Docs keyed by note id. Real implementation lands
//! in Task 4; this stub satisfies the `CrdtRuntime::new()` contract for Task 3.

use std::collections::HashMap;
use tokio::sync::Mutex;

pub struct DocStore {
    docs: Mutex<HashMap<String, yrs::Doc>>,
}

impl DocStore {
    pub fn new() -> Self {
        Self { docs: Mutex::new(HashMap::new()) }
    }

    pub async fn open_count(&self) -> usize {
        self.docs.lock().await.len()
    }
}
```

- [ ] **Step 3.5: Wire `CrdtRuntime` into `AppState`**

Edit `apps/desktop-tauri/src-tauri/src/app_state.rs`:

```rust
use crate::auth::linking::PendingLinkingRegistry;
use crate::auth::AuthRuntime;
use crate::crdt::CrdtRuntime;
use crate::db::Db;
use crate::vault::VaultRuntime;
use std::sync::Arc;

pub struct AppState {
    pub db: Db,
    pub vault: Arc<VaultRuntime>,
    pub auth: Arc<AuthRuntime>,
    pub linking: Arc<PendingLinkingRegistry>,
    pub crdt: Arc<CrdtRuntime>,
}

impl AppState {
    pub fn new(
        db: Db,
        vault: Arc<VaultRuntime>,
        auth: Arc<AuthRuntime>,
        linking: Arc<PendingLinkingRegistry>,
        crdt: Arc<CrdtRuntime>,
    ) -> Self {
        Self {
            db,
            vault,
            auth,
            linking,
            crdt,
        }
    }
}
```

- [ ] **Step 3.6: Register `crdt` module + construct in `lib.rs`**

Edit `apps/desktop-tauri/src-tauri/src/lib.rs`. Add `pub mod crdt;` near the other module declarations. Locate the `AppState::new(...)` call (it lives inside the `setup` closure) and pass `Arc::new(CrdtRuntime::new())` as the new last argument. Update any other `AppState::new` call sites the compiler reports.

- [ ] **Step 3.7: Run — expect PASS**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test crdt_runtime_test
```

Expected: 2 tests passing.

- [ ] **Step 3.8: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/crdt apps/desktop-tauri/src-tauri/src/app_state.rs apps/desktop-tauri/src-tauri/src/lib.rs apps/desktop-tauri/src-tauri/tests/crdt_runtime_test.rs
git commit -m "m5(crdt): scaffold CrdtRuntime + DocStore with origin tag"
```

---

### Task 4: Implement `DocStore` (`get_or_init`, `with_doc`, `drop_doc`)

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/crdt/docstore.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/crdt_docstore_test.rs`

- [ ] **Step 4.1: Write the failing tests**

Create `apps/desktop-tauri/src-tauri/tests/crdt_docstore_test.rs`:

```rust
use memry_desktop_tauri_lib::crdt::DocStore;
use yrs::{GetString, Text, Transact};

#[tokio::test]
async fn get_or_init_returns_same_doc_for_same_id() {
    let store = DocStore::new();
    let id = "note-alpha".to_string();

    let h1 = store.get_or_init(&id).await;
    let h2 = store.get_or_init(&id).await;

    h1.with_write(|txn| {
        let text = txn.get_or_insert_text("body");
        text.insert(txn, 0, "hello");
    });

    let snapshot = h2.with_read(|txn| txn.get_or_insert_text("body").get_string(txn));
    assert_eq!(snapshot, "hello");
    assert_eq!(store.open_count().await, 1);
}

#[tokio::test]
async fn drop_doc_removes_entry() {
    let store = DocStore::new();
    let id = "note-beta".to_string();
    let _h = store.get_or_init(&id).await;
    assert_eq!(store.open_count().await, 1);

    store.drop_doc(&id).await;
    assert_eq!(store.open_count().await, 0);
}

#[tokio::test]
async fn distinct_ids_get_distinct_docs() {
    let store = DocStore::new();
    let a = store.get_or_init("note-a").await;
    let b = store.get_or_init("note-b").await;
    a.with_write(|txn| txn.get_or_insert_text("body").insert(txn, 0, "A"));
    b.with_write(|txn| txn.get_or_insert_text("body").insert(txn, 0, "B"));

    let sa = a.with_read(|txn| txn.get_or_insert_text("body").get_string(txn));
    let sb = b.with_read(|txn| txn.get_or_insert_text("body").get_string(txn));
    assert_eq!(sa, "A");
    assert_eq!(sb, "B");
}
```

- [ ] **Step 4.2: Run — expect FAIL**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test crdt_docstore_test
```

Expected: errors on missing `get_or_init`, `with_write`, `drop_doc` methods.

- [ ] **Step 4.3: Implement `DocStore`**

Replace `apps/desktop-tauri/src-tauri/src/crdt/docstore.rs`:

```rust
//! In-memory store of open Y.Docs keyed by note id.
//!
//! Concurrency model:
//! - Outer map guarded by `tokio::sync::Mutex` — locked only while inserting
//!   or removing entries, never while running a transaction.
//! - Per-doc handle holds a `Doc` clone (Y.Doc is `Clone` and shares state).
//!   Read/write transactions take Yjs' internal lock; multiple `DocHandle`
//!   clones referencing the same logical doc see the same state.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use yrs::{Doc, ReadTxn, Transact, TransactionMut};

pub type NoteId = String;

#[derive(Clone)]
pub struct DocHandle {
    doc: Doc,
}

impl DocHandle {
    pub fn doc(&self) -> &Doc {
        &self.doc
    }

    pub fn with_read<R, F>(&self, f: F) -> R
    where
        F: FnOnce(&yrs::Transaction<'_>) -> R,
    {
        let txn = self.doc.transact();
        f(&txn)
    }

    pub fn with_write<R, F>(&self, f: F) -> R
    where
        F: FnOnce(&mut TransactionMut<'_>) -> R,
    {
        let mut txn = self.doc.transact_mut();
        f(&mut txn)
    }

    pub fn with_write_origin<R, F>(&self, origin: u32, f: F) -> R
    where
        F: FnOnce(&mut TransactionMut<'_>) -> R,
    {
        let mut txn = self.doc.transact_mut_with(origin);
        f(&mut txn)
    }
}

pub struct DocStore {
    docs: Mutex<HashMap<NoteId, Arc<Doc>>>,
}

impl DocStore {
    pub fn new() -> Self {
        Self {
            docs: Mutex::new(HashMap::new()),
        }
    }

    pub async fn open_count(&self) -> usize {
        self.docs.lock().await.len()
    }

    pub async fn get_or_init(&self, id: &str) -> DocHandle {
        let mut map = self.docs.lock().await;
        let doc = map.entry(id.to_string()).or_insert_with(|| Arc::new(Doc::new()));
        DocHandle { doc: (**doc).clone() }
    }

    pub async fn get(&self, id: &str) -> Option<DocHandle> {
        let map = self.docs.lock().await;
        map.get(id).map(|d| DocHandle { doc: (**d).clone() })
    }

    pub async fn drop_doc(&self, id: &str) {
        let mut map = self.docs.lock().await;
        map.remove(id);
    }

    pub async fn list_open(&self) -> Vec<NoteId> {
        let map = self.docs.lock().await;
        map.keys().cloned().collect()
    }
}

impl Default for DocStore {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 4.4: Re-export `DocHandle` from `crdt/mod.rs`**

Add to `crdt/mod.rs` exports:

```rust
pub use docstore::{DocHandle, DocStore, NoteId};
```

- [ ] **Step 4.5: Run — expect PASS**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test crdt_docstore_test
```

Expected: 3 tests passing.

- [ ] **Step 4.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/crdt apps/desktop-tauri/src-tauri/tests/crdt_docstore_test.rs
git commit -m "m5(crdt): implement DocStore with handle-based read/write transactions"
```

---

### Task 5: `crdt/apply.rs` — decode + apply v1 update with origin

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/crdt/apply.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/crdt/mod.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/crdt_apply_test.rs`

- [ ] **Step 5.1: Write the failing tests**

```rust
// apps/desktop-tauri/src-tauri/tests/crdt_apply_test.rs
use memry_desktop_tauri_lib::crdt::{apply_update_v1, DocStore};
use yrs::{GetString, Text, Transact};

#[tokio::test]
async fn apply_update_round_trip() {
    let source = DocStore::new();
    let target = DocStore::new();

    // Author on source
    let s = source.get_or_init("note-1").await;
    s.with_write(|txn| txn.get_or_insert_text("body").insert(txn, 0, "hello world"));

    // Encode update from empty state vector
    let snapshot = s.with_read(|txn| txn.encode_state_as_update_v1(&Default::default()));

    // Apply on target
    let t = target.get_or_init("note-1").await;
    apply_update_v1(&t, &snapshot, 42).expect("apply v1 update");

    let body = t.with_read(|txn| txn.get_or_insert_text("body").get_string(txn));
    assert_eq!(body, "hello world");
}

#[tokio::test]
async fn apply_invalid_bytes_returns_crdt_error() {
    let store = DocStore::new();
    let h = store.get_or_init("note-bogus").await;
    let err = apply_update_v1(&h, &[0xFF, 0xFF, 0xFF], 1).unwrap_err();
    let msg = format!("{err:?}");
    assert!(msg.to_lowercase().contains("crdt"));
}
```

- [ ] **Step 5.2: Run — expect FAIL**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test crdt_apply_test
```

Expected: missing `apply_update_v1` symbol.

- [ ] **Step 5.3: Implement**

```rust
// apps/desktop-tauri/src-tauri/src/crdt/apply.rs
//! Decode + apply a v1-encoded Y.js update to a DocHandle, stamped with an
//! origin tag so observers can attribute the update.

use crate::crdt::DocHandle;
use crate::error::{AppError, AppResult};
use yrs::updates::decoder::Decode;
use yrs::Update;

pub fn apply_update_v1(handle: &DocHandle, bytes: &[u8], origin: u32) -> AppResult<()> {
    let update = Update::decode_v1(bytes).map_err(AppError::from)?;
    handle.with_write_origin(origin, |txn| {
        txn.apply_update(update).map_err(AppError::from)
    })?;
    Ok(())
}
```

Add `pub mod apply; pub use apply::apply_update_v1;` to `crdt/mod.rs`.

- [ ] **Step 5.4: Run — expect PASS**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test crdt_apply_test
```

Expected: 2 tests passing.

- [ ] **Step 5.5: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/crdt apps/desktop-tauri/src-tauri/tests/crdt_apply_test.rs
git commit -m "m5(crdt): apply_update_v1 with origin tagging"
```

---

### Task 6: `crdt/snapshot.rs` — encode full state as v1 update

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/crdt/snapshot.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/crdt/mod.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/crdt_snapshot_test.rs`

- [ ] **Step 6.1: Write the failing tests**

```rust
// apps/desktop-tauri/src-tauri/tests/crdt_snapshot_test.rs
use memry_desktop_tauri_lib::crdt::{apply_update_v1, encode_snapshot_v1, DocStore};
use yrs::{GetString, Text, Transact};

#[tokio::test]
async fn snapshot_round_trips_through_fresh_doc() {
    let original = DocStore::new();
    let h = original.get_or_init("note").await;
    h.with_write(|txn| txn.get_or_insert_text("body").insert(txn, 0, "abc"));

    let snapshot = encode_snapshot_v1(&h).expect("encode");

    let restored = DocStore::new();
    let r = restored.get_or_init("note").await;
    apply_update_v1(&r, &snapshot, 1).unwrap();

    let body = r.with_read(|txn| txn.get_or_insert_text("body").get_string(txn));
    assert_eq!(body, "abc");
}

#[tokio::test]
async fn empty_doc_snapshot_is_minimal_but_valid() {
    let store = DocStore::new();
    let h = store.get_or_init("empty").await;
    let snapshot = encode_snapshot_v1(&h).expect("encode");
    assert!(!snapshot.is_empty());

    let other = DocStore::new();
    let o = other.get_or_init("empty").await;
    apply_update_v1(&o, &snapshot, 1).unwrap();
    let body = o.with_read(|txn| txn.get_or_insert_text("body").get_string(txn));
    assert_eq!(body, "");
}
```

- [ ] **Step 6.2: Run — expect FAIL**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test crdt_snapshot_test
```

- [ ] **Step 6.3: Implement**

```rust
// apps/desktop-tauri/src-tauri/src/crdt/snapshot.rs
use crate::crdt::DocHandle;
use crate::error::AppResult;
use yrs::ReadTxn;
use yrs::StateVector;

pub fn encode_snapshot_v1(handle: &DocHandle) -> AppResult<Vec<u8>> {
    let bytes = handle.with_read(|txn| txn.encode_state_as_update_v1(&StateVector::default()));
    Ok(bytes)
}

pub fn encode_diff_since_v1(handle: &DocHandle, sv_bytes: &[u8]) -> AppResult<Vec<u8>> {
    use yrs::updates::decoder::Decode;
    let sv = StateVector::decode_v1(sv_bytes).map_err(crate::error::AppError::from)?;
    let bytes = handle.with_read(|txn| txn.encode_state_as_update_v1(&sv));
    Ok(bytes)
}
```

Add `pub mod snapshot; pub use snapshot::{encode_snapshot_v1, encode_diff_since_v1};` to `crdt/mod.rs`.

- [ ] **Step 6.4: Run — expect PASS**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test crdt_snapshot_test
```

- [ ] **Step 6.5: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/crdt apps/desktop-tauri/src-tauri/tests/crdt_snapshot_test.rs
git commit -m "m5(crdt): encode_snapshot_v1 and encode_diff_since_v1"
```

---

### Task 7: `crdt/state_vector.rs` — encode state vector

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/crdt/state_vector.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/crdt/mod.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/crdt_state_vector_test.rs`

- [ ] **Step 7.1: Write the failing tests**

```rust
// apps/desktop-tauri/src-tauri/tests/crdt_state_vector_test.rs
use memry_desktop_tauri_lib::crdt::{
    apply_update_v1, encode_diff_since_v1, encode_state_vector_v1, DocStore,
};
use yrs::{GetString, Text, Transact};

#[tokio::test]
async fn diff_since_state_vector_only_returns_new_ops() {
    let alpha = DocStore::new();
    let a = alpha.get_or_init("n").await;
    a.with_write(|txn| txn.get_or_insert_text("body").insert(txn, 0, "first "));

    let sv = encode_state_vector_v1(&a).unwrap();

    a.with_write(|txn| txn.get_or_insert_text("body").insert(txn, 6, "second"));
    let diff = encode_diff_since_v1(&a, &sv).unwrap();

    // Apply only the diff to a doc that already has "first ".
    let beta = DocStore::new();
    let b = beta.get_or_init("n").await;
    let initial_snapshot = a.with_read(|txn| {
        let mut txn_a = txn;
        let _ = txn_a;
        b.doc().transact().encode_state_as_update_v1(&yrs::StateVector::default())
    });
    let _ = initial_snapshot; // unused — just illustrate

    // Apply the snapshot up to sv, then the diff, replicating the editor reload path.
    let snap_at_sv = a.with_read(|txn| txn.encode_state_as_update_v1(&yrs::StateVector::default()));
    apply_update_v1(&b, &snap_at_sv, 1).unwrap();
    apply_update_v1(&b, &diff, 1).unwrap();

    let body = b.with_read(|txn| txn.get_or_insert_text("body").get_string(txn));
    assert_eq!(body, "first second");
}
```

- [ ] **Step 7.2: Run — expect FAIL**

- [ ] **Step 7.3: Implement**

```rust
// apps/desktop-tauri/src-tauri/src/crdt/state_vector.rs
use crate::crdt::DocHandle;
use crate::error::AppResult;
use yrs::ReadTxn;

pub fn encode_state_vector_v1(handle: &DocHandle) -> AppResult<Vec<u8>> {
    let bytes = handle.with_read(|txn| txn.state_vector().encode_v1());
    Ok(bytes)
}
```

Add to `crdt/mod.rs`:

```rust
pub mod state_vector;
pub use state_vector::encode_state_vector_v1;
```

- [ ] **Step 7.4: Run — expect PASS**

- [ ] **Step 7.5: Commit**

```bash
git commit -am "m5(crdt): encode_state_vector_v1 with diff round-trip test"
```

---

### Task 8: `crdt/compaction.rs` — collapse N updates into snapshot

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/crdt/compaction.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/crdt/mod.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/crdt_compaction_test.rs`

- [ ] **Step 8.1: Write the failing tests**

```rust
// apps/desktop-tauri/src-tauri/tests/crdt_compaction_test.rs
use memry_desktop_tauri_lib::crdt::{
    apply_update_v1, compact_doc, encode_snapshot_v1, CompactionResult, DocStore,
};
use yrs::{GetString, Text, Transact};

#[tokio::test]
async fn compact_returns_snapshot_and_drop_seq() {
    let store = DocStore::new();
    let h = store.get_or_init("note").await;

    for i in 0..101 {
        h.with_write(|txn| {
            txn.get_or_insert_text("body").insert(txn, 0, &i.to_string());
        });
    }

    // Pretend updates 1..=101 are persisted; compaction emits a snapshot we'd
    // store and a max_seq we'd use to drop old rows.
    let result: CompactionResult = compact_doc(&h, 101).expect("compact");
    assert_eq!(result.replaced_through_seq, 101);
    assert!(!result.snapshot_bytes.is_empty());

    let restored = DocStore::new();
    let r = restored.get_or_init("note").await;
    apply_update_v1(&r, &result.snapshot_bytes, 1).unwrap();
    let body = r.with_read(|txn| txn.get_or_insert_text("body").get_string(txn));
    let original_body = h.with_read(|txn| txn.get_or_insert_text("body").get_string(txn));
    assert_eq!(body, original_body);
}
```

- [ ] **Step 8.2: Run — expect FAIL**

- [ ] **Step 8.3: Implement**

```rust
// apps/desktop-tauri/src-tauri/src/crdt/compaction.rs
//! Compaction policy: when more than N updates have accumulated for a note,
//! encode a fresh snapshot and signal the caller to drop persisted updates
//! whose seq is <= replaced_through_seq.

use crate::crdt::{encode_snapshot_v1, DocHandle};
use crate::error::AppResult;

pub const COMPACT_THRESHOLD: i64 = 100;

pub struct CompactionResult {
    pub snapshot_bytes: Vec<u8>,
    pub replaced_through_seq: i64,
}

pub fn compact_doc(handle: &DocHandle, max_seq: i64) -> AppResult<CompactionResult> {
    let snapshot_bytes = encode_snapshot_v1(handle)?;
    Ok(CompactionResult {
        snapshot_bytes,
        replaced_through_seq: max_seq,
    })
}
```

Add to `crdt/mod.rs`:

```rust
pub mod compaction;
pub use compaction::{compact_doc, CompactionResult, COMPACT_THRESHOLD};
```

- [ ] **Step 8.4: Run — expect PASS**

- [ ] **Step 8.5: Commit**

```bash
git commit -am "m5(crdt): compact_doc returns snapshot + max-seq for drop"
```

---

### Task 9: `crdt/wire.rs` — wire helpers for binary IPC

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/crdt/wire.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/crdt/mod.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/crdt_wire_test.rs`

- [ ] **Step 9.1: Write the failing tests**

```rust
// apps/desktop-tauri/src-tauri/tests/crdt_wire_test.rs
use memry_desktop_tauri_lib::crdt::wire::{CrdtUpdateEvent, CRDT_UPDATE_EVENT};

#[test]
fn event_name_matches_renderer_constant() {
    assert_eq!(CRDT_UPDATE_EVENT, "crdt-update");
}

#[test]
fn event_payload_serializes_with_origin() {
    let evt = CrdtUpdateEvent {
        note_id: "n1".into(),
        update: vec![1, 2, 3],
        origin: 7,
    };
    let json = serde_json::to_string(&evt).unwrap();
    assert!(json.contains("\"noteId\":\"n1\""));
    assert!(json.contains("\"origin\":7"));
}
```

- [ ] **Step 9.2: Run — expect FAIL**

- [ ] **Step 9.3: Implement**

```rust
// apps/desktop-tauri/src-tauri/src/crdt/wire.rs
use serde::Serialize;

pub const CRDT_UPDATE_EVENT: &str = "crdt-update";

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtUpdateEvent {
    pub note_id: String,
    pub update: Vec<u8>,
    pub origin: u32,
}
```

Add `pub mod wire;` to `crdt/mod.rs`.

- [ ] **Step 9.4: Run — expect PASS**

- [ ] **Step 9.5: Commit**

```bash
git commit -am "m5(crdt): wire helpers + CrdtUpdateEvent payload"
```

---

### Chunk 1 close-out

- [ ] Run the full crdt test slice:

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test 'crdt_*'
```

Expected: 11+ tests pass.

- [ ] Lint:

```bash
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

Expected: clean.

- [ ] No renderer changes yet — `pnpm test` and `pnpm test:e2e` should still pass exactly as on `main`.

---

## Chunk 2 — DB Layer

Goal: add the two new CRDT tables, flesh out the existing-but-skeletal db modules (`note_metadata`, `note_positions`, `notes_cache`, `folder_configs`, `tag_definitions`), and add `property_definitions.rs`. Acceptance proof at end: `cargo test --test 'db_*'` passes ≥30 tests; migrations 0029 and 0030 apply cleanly against an empty DB.

### Task 10: Schema diff baseline

**Files:** none modified.

- [ ] **Step 10.1: Snapshot current schema for parity audit**

```bash
pnpm --filter @memry/desktop-tauri tsx scripts/schema-diff.ts > /tmp/m5-schema-baseline.txt 2>&1 || true
```

Confirms M3/M4 leftover schema before M5 adds rows. The output is a planning aid; not committed.

- [ ] **Step 10.2: Confirm Electron source-of-truth tables exist**

```bash
grep -rE "CREATE TABLE (notes|crdt_updates|crdt_snapshots|note_metadata|property_definitions)" apps/desktop/src/main/database/drizzle-data/*.sql | head -20
```

Expected: hits for the Electron equivalents. M5 SQL ports these shapes.

- [ ] **Step 10.3: No commit** — research-only step.

---

### Task 11: Migration `0029_crdt_updates.sql`

**Files:**
- Create: `apps/desktop-tauri/src-tauri/migrations/0029_crdt_updates.sql`

- [ ] **Step 11.1: Author the migration**

```sql
-- M5: Persistent log of Y.js v1 updates per note.
--
-- seq is monotonic per note_id; on compaction, rows with seq <= replaced_seq
-- are deleted in the same transaction that writes the new snapshot. update_bytes
-- is BLOB so we can store binary v1 frames without UTF-8 round-trip damage.

CREATE TABLE crdt_updates (
    note_id text NOT NULL,
    seq integer NOT NULL,
    update_bytes blob NOT NULL,
    origin integer NOT NULL,
    created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    PRIMARY KEY (note_id, seq)
);

CREATE INDEX idx_crdt_updates_note ON crdt_updates (note_id, seq);
```

- [ ] **Step 11.2: Add an integration test**

Append to `apps/desktop-tauri/src-tauri/tests/migrations_test.rs` (or create if absent — see M2 plan for shape):

```rust
#[test]
fn migration_0029_crdt_updates_creates_table() {
    let conn = run_all_migrations_in_memory();
    let exists: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='crdt_updates'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(exists, 1);
}
```

- [ ] **Step 11.3: Run — expect PASS** (once Task 12 lands the second migration the test stays green)

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test
```

- [ ] **Step 11.4: Commit**

```bash
git add apps/desktop-tauri/src-tauri/migrations/0029_crdt_updates.sql apps/desktop-tauri/src-tauri/tests/migrations_test.rs
git commit -m "m5(db): migration 0029 — crdt_updates table"
```

---

### Task 12: Migration `0030_crdt_snapshots.sql`

**Files:**
- Create: `apps/desktop-tauri/src-tauri/migrations/0030_crdt_snapshots.sql`

- [ ] **Step 12.1: Author**

```sql
-- M5: Per-note compaction snapshot. `replaced_through_seq` lets us assert
-- that updates rows with seq <= replaced_through_seq were deleted at the
-- same transaction that wrote this snapshot; mismatched values caught by
-- db::crdt_snapshots::write_with_compaction integration tests.

CREATE TABLE crdt_snapshots (
    note_id text PRIMARY KEY NOT NULL,
    snapshot_bytes blob NOT NULL,
    state_vector blob NOT NULL,
    replaced_through_seq integer NOT NULL,
    created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
```

- [ ] **Step 12.2: Extend the migrations test**

```rust
#[test]
fn migration_0030_crdt_snapshots_creates_table() {
    let conn = run_all_migrations_in_memory();
    let exists: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='crdt_snapshots'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(exists, 1);
}
```

- [ ] **Step 12.3: Run — expect PASS**

- [ ] **Step 12.4: Commit**

```bash
git commit -am "m5(db): migration 0030 — crdt_snapshots table"
```

---

### Task 13: Register migrations in `db/migrations.rs`

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/db/migrations.rs`

- [ ] **Step 13.1: Add the two new files to the migrations list**

Locate the migration array (the existing list ends at `0028_calendar_source_last_error.sql`) and add:

```rust
include_str!("../../migrations/0029_crdt_updates.sql"),
include_str!("../../migrations/0030_crdt_snapshots.sql"),
```

- [ ] **Step 13.2: Verify with the migrations test**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test
```

Expected: all assertions pass; both new tables exist.

- [ ] **Step 13.3: Commit**

```bash
git commit -am "m5(db): register 0029 and 0030 migrations"
```

---

### Task 14: `db/mod.rs` — re-export new modules + AppError From impl review

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/db/mod.rs`

- [ ] **Step 14.1: Add module declarations**

Add (or confirm) the following module declarations:

```rust
pub mod crdt_snapshots;
pub mod crdt_updates;
pub mod note_metadata;
pub mod note_positions;
pub mod notes_cache;
pub mod property_definitions;
pub mod tag_definitions;
```

- [ ] **Step 14.2: Build**

```bash
pnpm --filter @memry/desktop-tauri cargo:check
```

Expected: empty modules don't fail compile.

- [ ] **Step 14.3: Commit**

```bash
git commit -am "m5(db): declare crdt_updates/crdt_snapshots/property_definitions modules"
```

---

### Task 15: Flesh out `db/note_metadata.rs`

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/db/note_metadata.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/db_note_metadata_test.rs`

- [ ] **Step 15.1: Write the failing tests**

```rust
// apps/desktop-tauri/src-tauri/tests/db_note_metadata_test.rs
use memry_desktop_tauri_lib::db::note_metadata::{
    delete_soft, get_by_id, get_by_path, list_active, rename_path, upsert, NoteMetadataRow,
};
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;

fn row(id: &str, path: &str, title: &str) -> NoteMetadataRow {
    NoteMetadataRow {
        id: id.to_string(),
        path: path.to_string(),
        title: title.to_string(),
        emoji: None,
        file_type: "markdown".into(),
        mime_type: None,
        file_size: None,
        attachment_id: None,
        attachment_references: None,
        local_only: false,
        sync_policy: "sync".into(),
        journal_date: None,
        property_definition_names: None,
        clock: None,
        synced_at: None,
        created_at: "2026-04-26T00:00:00.000Z".into(),
        modified_at: "2026-04-26T00:00:00.000Z".into(),
    }
}

#[test]
fn upsert_and_get() {
    let conn = open_in_memory_with_migrations();
    upsert(&conn, &row("n1", "Inbox/note-1.md", "First")).unwrap();

    let got = get_by_id(&conn, "n1").unwrap().expect("row");
    assert_eq!(got.title, "First");
    assert_eq!(got.path, "Inbox/note-1.md");

    let by_path = get_by_path(&conn, "Inbox/note-1.md").unwrap().expect("row");
    assert_eq!(by_path.id, "n1");
}

#[test]
fn list_active_excludes_deleted() {
    let conn = open_in_memory_with_migrations();
    upsert(&conn, &row("a", "a.md", "A")).unwrap();
    upsert(&conn, &row("b", "b.md", "B")).unwrap();
    delete_soft(&conn, "a", "2026-04-26T01:00:00.000Z").unwrap();

    let active = list_active(&conn).unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].id, "b");
}

#[test]
fn rename_path_updates_unique_index_atomically() {
    let conn = open_in_memory_with_migrations();
    upsert(&conn, &row("n", "old.md", "T")).unwrap();
    rename_path(&conn, "n", "new.md", "2026-04-26T02:00:00.000Z").unwrap();
    assert!(get_by_path(&conn, "old.md").unwrap().is_none());
    assert!(get_by_path(&conn, "new.md").unwrap().is_some());
}
```

- [ ] **Step 15.2: Add `test_helpers` module** (if missing)

Edit `apps/desktop-tauri/src-tauri/src/lib.rs`:

```rust
#[cfg(any(debug_assertions, feature = "test-helpers"))]
pub mod test_helpers;
```

Create `apps/desktop-tauri/src-tauri/src/test_helpers.rs`:

```rust
use crate::db::migrations::run_all;
use rusqlite::Connection;

pub fn open_in_memory_with_migrations() -> Connection {
    let mut conn = Connection::open_in_memory().expect("open in-memory");
    run_all(&mut conn).expect("apply migrations");
    conn
}
```

If `test_helpers` already exists from M2/M3, skip this step.

- [ ] **Step 15.3: Implement the module**

Replace `apps/desktop-tauri/src-tauri/src/db/note_metadata.rs`:

```rust
//! note_metadata table — id, path, title, sync metadata. Body content lives in
//! the vault filesystem; see `vault::notes_io`.

use crate::error::AppResult;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteMetadataRow {
    pub id: String,
    pub path: String,
    pub title: String,
    pub emoji: Option<String>,
    pub file_type: String,
    pub mime_type: Option<String>,
    pub file_size: Option<i64>,
    pub attachment_id: Option<String>,
    pub attachment_references: Option<String>,
    pub local_only: bool,
    pub sync_policy: String,
    pub journal_date: Option<String>,
    pub property_definition_names: Option<String>,
    pub clock: Option<String>,
    pub synced_at: Option<String>,
    pub created_at: String,
    pub modified_at: String,
}

const SELECT_COLS: &str = "id, path, title, emoji, file_type, mime_type, file_size, \
    attachment_id, attachment_references, local_only, sync_policy, journal_date, \
    property_definition_names, clock, synced_at, created_at, modified_at";

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteMetadataRow> {
    Ok(NoteMetadataRow {
        id: row.get(0)?,
        path: row.get(1)?,
        title: row.get(2)?,
        emoji: row.get(3)?,
        file_type: row.get(4)?,
        mime_type: row.get(5)?,
        file_size: row.get(6)?,
        attachment_id: row.get(7)?,
        attachment_references: row.get(8)?,
        local_only: row.get::<_, i64>(9)? != 0,
        sync_policy: row.get(10)?,
        journal_date: row.get(11)?,
        property_definition_names: row.get(12)?,
        clock: row.get(13)?,
        synced_at: row.get(14)?,
        created_at: row.get(15)?,
        modified_at: row.get(16)?,
    })
}

pub fn upsert(conn: &Connection, r: &NoteMetadataRow) -> AppResult<()> {
    conn.execute(
        "INSERT INTO note_metadata (
            id, path, title, emoji, file_type, mime_type, file_size,
            attachment_id, attachment_references, local_only, sync_policy,
            journal_date, property_definition_names, clock, synced_at,
            created_at, modified_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(id) DO UPDATE SET
            path=excluded.path,
            title=excluded.title,
            emoji=excluded.emoji,
            file_type=excluded.file_type,
            mime_type=excluded.mime_type,
            file_size=excluded.file_size,
            attachment_id=excluded.attachment_id,
            attachment_references=excluded.attachment_references,
            local_only=excluded.local_only,
            sync_policy=excluded.sync_policy,
            journal_date=excluded.journal_date,
            property_definition_names=excluded.property_definition_names,
            clock=excluded.clock,
            synced_at=excluded.synced_at,
            modified_at=excluded.modified_at",
        params![
            r.id,
            r.path,
            r.title,
            r.emoji,
            r.file_type,
            r.mime_type,
            r.file_size,
            r.attachment_id,
            r.attachment_references,
            r.local_only as i64,
            r.sync_policy,
            r.journal_date,
            r.property_definition_names,
            r.clock,
            r.synced_at,
            r.created_at,
            r.modified_at,
        ],
    )?;
    Ok(())
}

pub fn get_by_id(conn: &Connection, id: &str) -> AppResult<Option<NoteMetadataRow>> {
    let row = conn
        .query_row(
            &format!("SELECT {SELECT_COLS} FROM note_metadata WHERE id = ?1"),
            [id],
            map_row,
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(row)
}

pub fn get_by_path(conn: &Connection, path: &str) -> AppResult<Option<NoteMetadataRow>> {
    let row = conn
        .query_row(
            &format!("SELECT {SELECT_COLS} FROM note_metadata WHERE path = ?1"),
            [path],
            map_row,
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(row)
}

pub fn list_active(conn: &Connection) -> AppResult<Vec<NoteMetadataRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM note_metadata
         WHERE coalesce(json_extract(clock, '$.deleted_at'), '') = ''
         ORDER BY modified_at DESC"
    ))?;
    let rows = stmt.query_map([], map_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn list_in_folder(conn: &Connection, folder_prefix: &str) -> AppResult<Vec<NoteMetadataRow>> {
    let pattern = if folder_prefix.is_empty() {
        "%".to_string()
    } else {
        format!("{folder_prefix}/%")
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM note_metadata
         WHERE path LIKE ?1
           AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''
         ORDER BY modified_at DESC"
    ))?;
    let rows = stmt.query_map([pattern], map_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn rename_path(conn: &Connection, id: &str, new_path: &str, modified_at: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE note_metadata SET path = ?1, modified_at = ?2 WHERE id = ?3",
        params![new_path, modified_at, id],
    )?;
    Ok(())
}

pub fn delete_soft(conn: &Connection, id: &str, deleted_at: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE note_metadata
            SET clock = json_set(coalesce(clock, '{}'), '$.deleted_at', ?1),
                modified_at = ?1
          WHERE id = ?2",
        params![deleted_at, id],
    )?;
    Ok(())
}

pub fn set_local_only(conn: &Connection, id: &str, local_only: bool, modified_at: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE note_metadata SET local_only = ?1, modified_at = ?2 WHERE id = ?3",
        params![local_only as i64, modified_at, id],
    )?;
    Ok(())
}

pub fn count_local_only(conn: &Connection) -> AppResult<i64> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM note_metadata WHERE local_only = 1
            AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''",
        [],
        |row| row.get(0),
    )?;
    Ok(count)
}

pub fn exists_path(conn: &Connection, path: &str) -> AppResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM note_metadata WHERE path = ?1
            AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''",
        [path],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}
```

- [ ] **Step 15.4: Run — expect PASS**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test db_note_metadata_test
```

Expected: 3 tests pass.

- [ ] **Step 15.5: Commit**

```bash
git commit -am "m5(db): note_metadata CRUD with soft delete and rename"
```

---

### Task 16: Flesh out `db/note_positions.rs`

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/db/note_positions.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/db_note_positions_test.rs`

- [ ] **Step 16.1: Write the failing tests**

```rust
// apps/desktop-tauri/src-tauri/tests/db_note_positions_test.rs
use memry_desktop_tauri_lib::db::note_positions::{get_all, get_for_folder, reorder};
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;

#[test]
fn reorder_writes_positions() {
    let conn = open_in_memory_with_migrations();
    reorder(
        &conn,
        "Inbox",
        &["a".into(), "b".into(), "c".into()],
    )
    .unwrap();

    let pos = get_for_folder(&conn, "Inbox").unwrap();
    assert_eq!(pos.get("a").copied(), Some(0));
    assert_eq!(pos.get("b").copied(), Some(1));
    assert_eq!(pos.get("c").copied(), Some(2));
}

#[test]
fn reorder_replaces_previous_state() {
    let conn = open_in_memory_with_migrations();
    reorder(&conn, "Inbox", &["a".into(), "b".into()]).unwrap();
    reorder(&conn, "Inbox", &["b".into(), "a".into(), "c".into()]).unwrap();

    let pos = get_for_folder(&conn, "Inbox").unwrap();
    assert_eq!(pos.get("b").copied(), Some(0));
    assert_eq!(pos.get("a").copied(), Some(1));
    assert_eq!(pos.get("c").copied(), Some(2));
}

#[test]
fn get_all_returns_flat_map_keyed_by_note_id() {
    let conn = open_in_memory_with_migrations();
    reorder(&conn, "Inbox", &["a".into(), "b".into()]).unwrap();
    reorder(&conn, "Projects", &["c".into()]).unwrap();
    let all = get_all(&conn).unwrap();
    assert_eq!(all.get("a").copied(), Some(0));
    assert_eq!(all.get("c").copied(), Some(0));
    assert_eq!(all.len(), 3);
}
```

- [ ] **Step 16.2: Run — expect FAIL**

- [ ] **Step 16.3: Implement**

```rust
// apps/desktop-tauri/src-tauri/src/db/note_positions.rs
use crate::error::AppResult;
use rusqlite::{params, Connection};
use std::collections::HashMap;

pub fn reorder(conn: &Connection, folder_path: &str, note_ids: &[String]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM note_positions WHERE folder_path = ?1",
        [folder_path],
    )?;
    for (i, id) in note_ids.iter().enumerate() {
        tx.execute(
            "INSERT INTO note_positions (folder_path, note_id, position) VALUES (?1, ?2, ?3)",
            params![folder_path, id, i as i64],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn get_for_folder(conn: &Connection, folder_path: &str) -> AppResult<HashMap<String, i64>> {
    let mut stmt = conn.prepare(
        "SELECT note_id, position FROM note_positions WHERE folder_path = ?1 ORDER BY position",
    )?;
    let rows = stmt.query_map([folder_path], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, pos) = row?;
        out.insert(id, pos);
    }
    Ok(out)
}

pub fn get_all(conn: &Connection) -> AppResult<HashMap<String, i64>> {
    let mut stmt = conn.prepare("SELECT note_id, position FROM note_positions")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, pos) = row?;
        out.insert(id, pos);
    }
    Ok(out)
}

pub fn drop_for_note(conn: &Connection, note_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM note_positions WHERE note_id = ?1", [note_id])?;
    Ok(())
}
```

- [ ] **Step 16.4: Run — expect PASS**

- [ ] **Step 16.5: Commit**

```bash
git commit -am "m5(db): note_positions reorder + get_for_folder/get_all"
```

---

### Task 17: Flesh out `db/notes_cache.rs`

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/db/notes_cache.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/db_notes_cache_test.rs`

- [ ] **Step 17.1: Schema check**

`notes_cache` was declared as a stub in M2; verify the table exists:

```bash
grep -rn "CREATE TABLE notes_cache" apps/desktop-tauri/src-tauri/migrations/
```

If absent, add `apps/desktop-tauri/src-tauri/migrations/0031_notes_cache.sql`:

```sql
-- M5: snapshot of derived list-view fields. Refreshed on every notes_create /
-- notes_update / notes_delete. Avoids re-reading body markdown on list paginates.

CREATE TABLE IF NOT EXISTS notes_cache (
    id text PRIMARY KEY NOT NULL,
    title text NOT NULL,
    path text NOT NULL,
    snippet text NOT NULL DEFAULT '',
    word_count integer NOT NULL DEFAULT 0,
    tags_json text NOT NULL DEFAULT '[]',
    emoji text,
    modified_at text NOT NULL,
    created_at text NOT NULL,
    local_only integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notes_cache_modified ON notes_cache (modified_at DESC);
```

If you add this file, also append to `db/migrations.rs`. Renumber if 0031 collides — at the time of writing it does not.

- [ ] **Step 17.2: Write tests + impl**

Tests cover: `refresh_from_metadata` (single row), `list_active(limit, offset, sort_by)`, `delete(id)`. See pattern in Task 15. Implementation populates `snippet` from the first 200 chars of the body file (read via `vault::notes_io::read_note_from_disk`) and `word_count` by splitting on whitespace.

- [ ] **Step 17.3: Run + Commit**

```bash
git commit -am "m5(db): notes_cache refresh + paginated list_active"
```

---

### Task 18: Flesh out `db/folder_configs.rs`

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/db/folder_configs.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/db_folder_configs_test.rs`

- [ ] **Step 18.1: Tests**

```rust
// apps/desktop-tauri/src-tauri/tests/db_folder_configs_test.rs
use memry_desktop_tauri_lib::db::folder_configs::{get, get_template_inherited, set, FolderConfigRow};
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;

#[test]
fn round_trip_config() {
    let conn = open_in_memory_with_migrations();
    let cfg = FolderConfigRow {
        path: "Projects".into(),
        icon: Some("folder-kanban".into()),
        template_json: Some(r#"{"frontmatter":{"status":"active"}}"#.into()),
    };
    set(&conn, &cfg).unwrap();
    let got = get(&conn, "Projects").unwrap().expect("row");
    assert_eq!(got.icon.as_deref(), Some("folder-kanban"));
}

#[test]
fn template_inherits_from_parent() {
    let conn = open_in_memory_with_migrations();
    set(
        &conn,
        &FolderConfigRow {
            path: "Projects".into(),
            icon: None,
            template_json: Some(r#"{"frontmatter":{"status":"active"}}"#.into()),
        },
    )
    .unwrap();
    let inherited = get_template_inherited(&conn, "Projects/sub/deep")
        .unwrap()
        .expect("template");
    assert!(inherited.contains("\"status\":\"active\""));
}
```

- [ ] **Step 18.2: Implement** (set/get/delete + ancestor walk for `get_template_inherited`)

- [ ] **Step 18.3: Commit**

```bash
git commit -am "m5(db): folder_configs CRUD with parent template inheritance"
```

---

### Task 19: Flesh out `db/tag_definitions.rs`

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/db/tag_definitions.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/db_tag_definitions_test.rs`

- [ ] **Step 19.1: Tests**

Cover: `list_with_counts` aggregating tag occurrences from `note_metadata.property_definition_names` JSON and from inline `#tag` mentions in the body cache; `upsert(name, color)`; `rename(old, new)`.

- [ ] **Step 19.2: Implement** with the same JSON-aggregation pattern as Electron's `notes-queries.ts`. Read the cache snippet for `#tag` patterns; we keep this approximate for M5 — exact tag indexing lands with FTS in M7.

- [ ] **Step 19.3: Commit**

```bash
git commit -am "m5(db): tag_definitions list/upsert/rename"
```

---

### Task 20: New `db/property_definitions.rs`

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/db/property_definitions.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/db_property_definitions_test.rs`

- [ ] **Step 20.1: Tests**

```rust
// apps/desktop-tauri/src-tauri/tests/db_property_definitions_test.rs
use memry_desktop_tauri_lib::db::property_definitions::{
    add_option, create, delete, list, remove_option, rename_option, update_option_color,
    PropertyDefinitionRow,
};
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;

fn def(name: &str, ty: &str) -> PropertyDefinitionRow {
    PropertyDefinitionRow {
        name: name.into(),
        ty: ty.into(),
        options: None,
        default_value: None,
        color: None,
        created_at: "2026-04-26T00:00:00.000Z".into(),
    }
}

#[test]
fn create_and_list() {
    let conn = open_in_memory_with_migrations();
    create(&conn, &def("status", "select")).unwrap();
    let all = list(&conn).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].name, "status");
}

#[test]
fn add_and_remove_option() {
    let conn = open_in_memory_with_migrations();
    create(&conn, &def("status", "select")).unwrap();
    add_option(&conn, "status", "active", Some("#10b981")).unwrap();
    add_option(&conn, "status", "blocked", Some("#ef4444")).unwrap();

    let row = list(&conn).unwrap().into_iter().next().unwrap();
    let opts: serde_json::Value = serde_json::from_str(&row.options.unwrap()).unwrap();
    assert_eq!(opts.as_array().unwrap().len(), 2);

    remove_option(&conn, "status", "blocked").unwrap();
    let row2 = list(&conn).unwrap().into_iter().next().unwrap();
    let opts2: serde_json::Value = serde_json::from_str(&row2.options.unwrap()).unwrap();
    assert_eq!(opts2.as_array().unwrap().len(), 1);
}

#[test]
fn rename_option_preserves_color() {
    let conn = open_in_memory_with_migrations();
    create(&conn, &def("status", "select")).unwrap();
    add_option(&conn, "status", "active", Some("#10b981")).unwrap();
    rename_option(&conn, "status", "active", "in-progress").unwrap();
    let row = list(&conn).unwrap().into_iter().next().unwrap();
    let opts: serde_json::Value = serde_json::from_str(&row.options.unwrap()).unwrap();
    assert_eq!(opts[0]["name"], "in-progress");
    assert_eq!(opts[0]["color"], "#10b981");
}

#[test]
fn delete_removes_definition() {
    let conn = open_in_memory_with_migrations();
    create(&conn, &def("status", "select")).unwrap();
    delete(&conn, "status").unwrap();
    assert_eq!(list(&conn).unwrap().len(), 0);
}
```

- [ ] **Step 20.2: Implement**

```rust
// apps/desktop-tauri/src-tauri/src/db/property_definitions.rs
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDefinitionRow {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub options: Option<String>, // JSON array of {name, color}
    pub default_value: Option<String>,
    pub color: Option<String>,
    pub created_at: String,
}

fn map(row: &rusqlite::Row<'_>) -> rusqlite::Result<PropertyDefinitionRow> {
    Ok(PropertyDefinitionRow {
        name: row.get(0)?,
        ty: row.get(1)?,
        options: row.get(2)?,
        default_value: row.get(3)?,
        color: row.get(4)?,
        created_at: row.get(5)?,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<PropertyDefinitionRow>> {
    let mut stmt = conn.prepare(
        "SELECT name, type, options, default_value, color, created_at FROM property_definitions ORDER BY name",
    )?;
    let rows = stmt.query_map([], map)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get(conn: &Connection, name: &str) -> AppResult<Option<PropertyDefinitionRow>> {
    let row = conn
        .query_row(
            "SELECT name, type, options, default_value, color, created_at
                 FROM property_definitions WHERE name = ?1",
            [name],
            map,
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(row)
}

pub fn create(conn: &Connection, def: &PropertyDefinitionRow) -> AppResult<()> {
    conn.execute(
        "INSERT INTO property_definitions (name, type, options, default_value, color, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            def.name,
            def.ty,
            def.options,
            def.default_value,
            def.color,
            def.created_at,
        ],
    )?;
    Ok(())
}

pub fn update_type(conn: &Connection, name: &str, new_type: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE property_definitions SET type = ?1 WHERE name = ?2",
        params![new_type, name],
    )?;
    Ok(())
}

pub fn ensure(conn: &Connection, name: &str, ty: &str, default_value: Option<&str>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO property_definitions (name, type, default_value, created_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(name) DO NOTHING",
        params![name, ty, default_value],
    )?;
    Ok(())
}

fn read_options_array(conn: &Connection, name: &str) -> AppResult<Vec<Value>> {
    let row = get(conn, name)?.ok_or_else(|| AppError::NotFound(format!("property {name}")))?;
    let arr = match row.options {
        Some(s) => serde_json::from_str::<Value>(&s).unwrap_or_else(|_| json!([])),
        None => json!([]),
    };
    Ok(arr.as_array().cloned().unwrap_or_default())
}

fn write_options_array(conn: &Connection, name: &str, opts: &[Value]) -> AppResult<()> {
    let s = serde_json::to_string(opts)?;
    conn.execute(
        "UPDATE property_definitions SET options = ?1 WHERE name = ?2",
        params![s, name],
    )?;
    Ok(())
}

pub fn add_option(conn: &Connection, name: &str, option_name: &str, color: Option<&str>) -> AppResult<()> {
    let mut opts = read_options_array(conn, name)?;
    if opts.iter().any(|v| v["name"] == option_name) {
        return Ok(());
    }
    opts.push(json!({ "name": option_name, "color": color }));
    write_options_array(conn, name, &opts)
}

pub fn remove_option(conn: &Connection, name: &str, option_name: &str) -> AppResult<()> {
    let mut opts = read_options_array(conn, name)?;
    opts.retain(|v| v["name"] != option_name);
    write_options_array(conn, name, &opts)
}

pub fn rename_option(conn: &Connection, name: &str, old: &str, new: &str) -> AppResult<()> {
    let mut opts = read_options_array(conn, name)?;
    for opt in opts.iter_mut() {
        if opt["name"] == old {
            opt["name"] = json!(new);
        }
    }
    write_options_array(conn, name, &opts)
}

pub fn update_option_color(conn: &Connection, name: &str, option_name: &str, color: &str) -> AppResult<()> {
    let mut opts = read_options_array(conn, name)?;
    for opt in opts.iter_mut() {
        if opt["name"] == option_name {
            opt["color"] = json!(color);
        }
    }
    write_options_array(conn, name, &opts)
}

pub fn add_status_option(
    conn: &Connection,
    name: &str,
    category: &str,
    option_name: &str,
    color: Option<&str>,
) -> AppResult<()> {
    let mut opts = read_options_array(conn, name)?;
    let entry = json!({
        "name": option_name,
        "color": color,
        "category": category,
    });
    if !opts.iter().any(|v| v["name"] == option_name && v["category"] == category) {
        opts.push(entry);
        write_options_array(conn, name, &opts)?;
    }
    Ok(())
}

pub fn delete(conn: &Connection, name: &str) -> AppResult<()> {
    conn.execute("DELETE FROM property_definitions WHERE name = ?1", [name])?;
    Ok(())
}
```

- [ ] **Step 20.3: Run — expect PASS**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test db_property_definitions_test
```

- [ ] **Step 20.4: Commit**

```bash
git commit -am "m5(db): property_definitions full CRUD + option/status helpers"
```

---

### Task 21: New `db/crdt_updates.rs`

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/db/crdt_updates.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/db_crdt_updates_test.rs`

- [ ] **Step 21.1: Tests**

```rust
// apps/desktop-tauri/src-tauri/tests/db_crdt_updates_test.rs
use memry_desktop_tauri_lib::db::crdt_updates::{
    append, drop_through, list_for_note, max_seq, MAX_BLOB_BYTES,
};
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;

#[test]
fn append_and_list_in_seq_order() {
    let conn = open_in_memory_with_migrations();
    append(&conn, "n", &[1, 2], 7).unwrap();
    append(&conn, "n", &[3, 4], 7).unwrap();

    let rows = list_for_note(&conn, "n").unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].seq, 1);
    assert_eq!(rows[0].update_bytes, vec![1, 2]);
    assert_eq!(rows[1].seq, 2);
}

#[test]
fn max_seq_returns_zero_for_empty() {
    let conn = open_in_memory_with_migrations();
    assert_eq!(max_seq(&conn, "missing").unwrap(), 0);
}

#[test]
fn drop_through_removes_inclusive_range() {
    let conn = open_in_memory_with_migrations();
    for i in 0..5 {
        append(&conn, "n", &[i as u8], 1).unwrap();
    }
    drop_through(&conn, "n", 3).unwrap();
    let rows = list_for_note(&conn, "n").unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].seq, 4);
}

#[test]
fn rejects_oversized_payload() {
    let conn = open_in_memory_with_migrations();
    let too_big = vec![0u8; MAX_BLOB_BYTES + 1];
    let err = append(&conn, "n", &too_big, 1).unwrap_err();
    let msg = format!("{err:?}");
    assert!(msg.to_lowercase().contains("validation"));
}
```

- [ ] **Step 21.2: Implement**

```rust
// apps/desktop-tauri/src-tauri/src/db/crdt_updates.rs
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::Serialize;

pub const MAX_BLOB_BYTES: usize = 4 * 1024 * 1024; // 4 MB hard cap per row

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtUpdateRow {
    pub note_id: String,
    pub seq: i64,
    pub update_bytes: Vec<u8>,
    pub origin: i64,
    pub created_at: String,
}

pub fn append(conn: &Connection, note_id: &str, bytes: &[u8], origin: i64) -> AppResult<i64> {
    if bytes.len() > MAX_BLOB_BYTES {
        return Err(AppError::Validation(format!(
            "crdt update {} bytes exceeds cap {}",
            bytes.len(),
            MAX_BLOB_BYTES
        )));
    }
    let next = max_seq(conn, note_id)? + 1;
    conn.execute(
        "INSERT INTO crdt_updates (note_id, seq, update_bytes, origin) VALUES (?1, ?2, ?3, ?4)",
        params![note_id, next, bytes, origin],
    )?;
    Ok(next)
}

pub fn max_seq(conn: &Connection, note_id: &str) -> AppResult<i64> {
    let seq: Option<i64> = conn
        .query_row(
            "SELECT max(seq) FROM crdt_updates WHERE note_id = ?1",
            [note_id],
            |row| row.get(0),
        )
        .ok();
    Ok(seq.unwrap_or(0))
}

pub fn list_for_note(conn: &Connection, note_id: &str) -> AppResult<Vec<CrdtUpdateRow>> {
    let mut stmt = conn.prepare(
        "SELECT note_id, seq, update_bytes, origin, created_at
           FROM crdt_updates WHERE note_id = ?1 ORDER BY seq",
    )?;
    let rows = stmt.query_map([note_id], |row| {
        Ok(CrdtUpdateRow {
            note_id: row.get(0)?,
            seq: row.get(1)?,
            update_bytes: row.get(2)?,
            origin: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn drop_through(conn: &Connection, note_id: &str, seq: i64) -> AppResult<()> {
    conn.execute(
        "DELETE FROM crdt_updates WHERE note_id = ?1 AND seq <= ?2",
        params![note_id, seq],
    )?;
    Ok(())
}
```

- [ ] **Step 21.3: Commit**

```bash
git commit -am "m5(db): crdt_updates append/list/drop_through with size cap"
```

---

### Task 22: New `db/crdt_snapshots.rs`

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/db/crdt_snapshots.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/db_crdt_snapshots_test.rs`

- [ ] **Step 22.1: Tests**

Cover: `upsert(snapshot_bytes, state_vector, replaced_through_seq)` writes both the snapshot and drops `crdt_updates` rows where seq ≤ replaced_through_seq inside one transaction; `get_latest(note_id)` returns the persisted snapshot; round-tripping through `apply_update_v1` after replay reconstructs identical state.

- [ ] **Step 22.2: Implement** — wrap upsert + drop_through in `conn.unchecked_transaction()` so partial writes never strand updates.

```rust
// apps/desktop-tauri/src-tauri/src/db/crdt_snapshots.rs
use crate::db::crdt_updates;
use crate::error::AppResult;
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtSnapshotRow {
    pub note_id: String,
    pub snapshot_bytes: Vec<u8>,
    pub state_vector: Vec<u8>,
    pub replaced_through_seq: i64,
    pub created_at: String,
}

pub fn upsert_with_compaction(
    conn: &Connection,
    note_id: &str,
    snapshot_bytes: &[u8],
    state_vector: &[u8],
    replaced_through_seq: i64,
) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO crdt_snapshots (note_id, snapshot_bytes, state_vector, replaced_through_seq)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(note_id) DO UPDATE SET
            snapshot_bytes = excluded.snapshot_bytes,
            state_vector = excluded.state_vector,
            replaced_through_seq = excluded.replaced_through_seq,
            created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        params![note_id, snapshot_bytes, state_vector, replaced_through_seq],
    )?;
    crdt_updates::drop_through(&tx, note_id, replaced_through_seq)?;
    tx.commit()?;
    Ok(())
}

pub fn get_latest(conn: &Connection, note_id: &str) -> AppResult<Option<CrdtSnapshotRow>> {
    let row = conn
        .query_row(
            "SELECT note_id, snapshot_bytes, state_vector, replaced_through_seq, created_at
               FROM crdt_snapshots WHERE note_id = ?1",
            [note_id],
            |r| {
                Ok(CrdtSnapshotRow {
                    note_id: r.get(0)?,
                    snapshot_bytes: r.get(1)?,
                    state_vector: r.get(2)?,
                    replaced_through_seq: r.get(3)?,
                    created_at: r.get(4)?,
                })
            },
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(row)
}
```

- [ ] **Step 22.3: Commit**

```bash
git commit -am "m5(db): crdt_snapshots upsert+compaction in single tx"
```

---

### Chunk 2 close-out

- [ ] Run all db tests:

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test 'db_*' --test migrations_test
```

Expected: ≥30 tests pass.

- [ ] `cargo:clippy` clean, no renderer changes yet.

---

## Chunk 3 — Notes Commands (CRUD + parity surface)

Goal: ship Tauri commands for the basic notes lifecycle. Each command is thin: validate input → call `vault::notes_io` for FS work → call `db::note_metadata` / `db::notes_cache` for DB work → emit events → return the renderer-shape DTO. Acceptance proof at end: `cargo test --test commands_notes_test` passes ≥18 tests; bindings regenerate cleanly.

### Task 23: Shared `commands::notes` types + helpers

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/commands/notes.rs` (skeleton)

- [ ] **Step 23.1: Skeleton + DTOs**

```rust
//! Notes IPC commands. Thin handlers that compose vault FS + DB + CRDT.

use crate::app_state::AppState;
use crate::db::note_metadata::NoteMetadataRow;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// Renderer-shape note (matches `@memry/contracts/notes-api.ts::Note`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteDto {
    pub id: String,
    pub path: String,
    pub title: String,
    pub content: String,
    pub frontmatter: serde_json::Value,
    pub created: String,
    pub modified: String,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub word_count: i64,
    pub emoji: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteListItem {
    pub id: String,
    pub path: String,
    pub title: String,
    pub created: String,
    pub modified: String,
    pub tags: Vec<String>,
    pub word_count: i64,
    pub snippet: String,
    pub emoji: Option<String>,
    pub local_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteListResponse {
    pub notes: Vec<NoteListItem>,
    pub total: i64,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteCreateInput {
    pub title: String,
    pub content: Option<String>,
    pub folder: Option<String>,
    pub tags: Option<Vec<String>>,
    pub template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteCreateResponse {
    pub success: bool,
    pub note: Option<NoteDto>,
    pub error: Option<String>,
}

fn into_dto(row: &NoteMetadataRow, body: &str) -> NoteDto {
    NoteDto {
        id: row.id.clone(),
        path: row.path.clone(),
        title: row.title.clone(),
        content: body.to_string(),
        frontmatter: serde_json::Value::Object(Default::default()),
        created: row.created_at.clone(),
        modified: row.modified_at.clone(),
        tags: Vec::new(),
        aliases: Vec::new(),
        word_count: body.split_whitespace().count() as i64,
        emoji: row.emoji.clone(),
    }
}

pub(crate) fn snippet_of(body: &str) -> String {
    body.chars().take(200).collect()
}

pub(crate) fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = nanos.as_secs();
    let millis = nanos.subsec_millis();
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(secs as i64, millis * 1_000_000)
        .unwrap_or_else(chrono::Utc::now);
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}
```

If `chrono` is not yet in `Cargo.toml`, add it with `chrono = { version = "0.4", features = ["serde"] }` in this same task (or pull `time` if the team already prefers it — search before adding).

- [ ] **Step 23.2: Register module**

Edit `commands/mod.rs`:

```rust
pub mod notes;
```

- [ ] **Step 23.3: Build**

```bash
pnpm --filter @memry/desktop-tauri cargo:check
```

- [ ] **Step 23.4: Commit**

```bash
git commit -am "m5(cmd): scaffold commands/notes.rs with DTO types"
```

---

### Task 24: `notes_create`

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/commands/notes.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/commands_notes_create_test.rs`

- [ ] **Step 24.1: Test (TDD)**

```rust
// apps/desktop-tauri/src-tauri/tests/commands_notes_create_test.rs
use memry_desktop_tauri_lib::commands::notes::{notes_create_inner, NoteCreateInput};
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;

#[tokio::test]
async fn create_note_writes_metadata_and_returns_dto() {
    let conn = open_in_memory_with_migrations();
    let vault = memry_desktop_tauri_lib::test_helpers::test_vault_runtime();
    let result = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Hello".into(),
            content: Some("# Body".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap();
    assert!(result.success);
    let note = result.note.unwrap();
    assert_eq!(note.title, "Hello");
    assert!(note.path.starts_with("Inbox/"));
    assert!(note.path.ends_with(".md"));
}
```

If `test_vault_runtime()` doesn't exist, add it to `test_helpers.rs`:

```rust
pub fn test_vault_runtime() -> std::sync::Arc<crate::vault::VaultRuntime> {
    use crate::vault::VaultRuntime;
    let tmp = tempfile::tempdir().expect("temp vault");
    let runtime = VaultRuntime::open_for_test(tmp.path()).expect("open vault");
    std::sync::Arc::new(runtime)
}
```

`VaultRuntime::open_for_test` is a thin wrapper around the M3 setup; if not present, expose it behind `#[cfg(any(debug_assertions, feature = "test-helpers"))]`.

- [ ] **Step 24.2: Run — expect FAIL**

- [ ] **Step 24.3: Implement `notes_create_inner` and the wrapping `notes_create` command**

Append to `commands/notes.rs`:

```rust
pub async fn notes_create_inner(
    conn: &rusqlite::Connection,
    vault: &crate::vault::VaultRuntime,
    input: NoteCreateInput,
) -> AppResult<NoteCreateResponse> {
    use crate::db::{note_metadata, notes_cache};

    if input.title.trim().is_empty() {
        return Err(AppError::Validation("title is empty".into()));
    }

    let folder = input.folder.unwrap_or_default();
    let slug = slug_for(&input.title);
    let relative = if folder.is_empty() {
        format!("{slug}.md")
    } else {
        format!("{folder}/{slug}.md")
    };

    let body = input.content.unwrap_or_default();
    let id = nanoid::nanoid!(21);
    let now = now_iso();

    vault.notes_io().write_note(&relative, &body).await?;

    let row = NoteMetadataRow {
        id: id.clone(),
        path: relative.clone(),
        title: input.title,
        emoji: None,
        file_type: "markdown".into(),
        mime_type: None,
        file_size: Some(body.len() as i64),
        attachment_id: None,
        attachment_references: None,
        local_only: false,
        sync_policy: "sync".into(),
        journal_date: None,
        property_definition_names: None,
        clock: None,
        synced_at: None,
        created_at: now.clone(),
        modified_at: now.clone(),
    };
    note_metadata::upsert(conn, &row)?;
    notes_cache::refresh_for(conn, &row, &body)?;

    Ok(NoteCreateResponse {
        success: true,
        note: Some(into_dto(&row, &body)),
        error: None,
    })
}

fn slug_for(title: &str) -> String {
    title
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

#[tauri::command]
#[specta::specta]
pub async fn notes_create(
    state: State<'_, AppState>,
    app: AppHandle,
    input: NoteCreateInput,
) -> AppResult<NoteCreateResponse> {
    let conn = state.db.conn().lock().await;
    let resp = notes_create_inner(&conn, &state.vault, input).await?;
    if let Some(note) = &resp.note {
        let _ = app.emit("notes:created", serde_json::json!({ "note": note, "source": "internal" }));
    }
    Ok(resp)
}
```

- [ ] **Step 24.4: Register in `lib.rs`**

Add `commands::notes::notes_create` to the `tauri::generate_handler!` invocation **and** the `tauri-specta` builder. The exact line is in `lib.rs::run` — match the M4 pattern.

- [ ] **Step 24.5: Run — expect PASS**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test commands_notes_create_test
```

- [ ] **Step 24.6: Commit**

```bash
git commit -am "m5(cmd): notes_create writes vault FS + metadata + cache; emits notes:created"
```

---

### Task 25: `notes_get` + `notes_get_by_path`

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/commands/notes.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/commands_notes_get_test.rs`

- [ ] **Step 25.1: Tests** — create note via inner, then assert get-by-id and get-by-path round-trip the same DTO.

- [ ] **Step 25.2: Implement**

```rust
#[tauri::command]
#[specta::specta]
pub async fn notes_get(state: State<'_, AppState>, id: String) -> AppResult<Option<NoteDto>> {
    let conn = state.db.conn().lock().await;
    let Some(row) = crate::db::note_metadata::get_by_id(&conn, &id)? else {
        return Ok(None);
    };
    let body = state.vault.notes_io().read_note(&row.path).await?;
    Ok(Some(into_dto(&row, &body)))
}

#[tauri::command]
#[specta::specta]
pub async fn notes_get_by_path(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<Option<NoteDto>> {
    let conn = state.db.conn().lock().await;
    let Some(row) = crate::db::note_metadata::get_by_path(&conn, &path)? else {
        return Ok(None);
    };
    let body = state.vault.notes_io().read_note(&row.path).await?;
    Ok(Some(into_dto(&row, &body)))
}
```

- [ ] **Step 25.3: Register, run, commit**

```bash
git commit -am "m5(cmd): notes_get + notes_get_by_path"
```

---

### Task 26: `notes_update`

**Files:** as Task 24.

- [ ] **Step 26.1: Tests** — assert update changes title/body/emoji/tags; modified_at advances; vault FS reflects new body; cache snippet updates.

- [ ] **Step 26.2: Implement**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdateInput {
    pub id: String,
    pub title: Option<String>,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
    pub frontmatter: Option<serde_json::Value>,
    pub emoji: Option<Option<String>>, // explicit double-Option to allow clearing
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdateResponse {
    pub success: bool,
    pub note: Option<NoteDto>,
    pub error: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn notes_update(
    state: State<'_, AppState>,
    app: AppHandle,
    input: NoteUpdateInput,
) -> AppResult<NoteUpdateResponse> {
    let conn = state.db.conn().lock().await;
    let mut row = crate::db::note_metadata::get_by_id(&conn, &input.id)?
        .ok_or_else(|| AppError::NotFound(format!("note {}", input.id)))?;

    if let Some(t) = &input.title {
        row.title = t.clone();
    }
    if let Some(emoji_opt) = &input.emoji {
        row.emoji = emoji_opt.clone();
    }

    let body = match input.content {
        Some(c) => {
            state.vault.notes_io().write_note(&row.path, &c).await?;
            row.file_size = Some(c.len() as i64);
            c
        }
        None => state.vault.notes_io().read_note(&row.path).await?,
    };

    row.modified_at = now_iso();
    crate::db::note_metadata::upsert(&conn, &row)?;
    crate::db::notes_cache::refresh_for(&conn, &row, &body)?;

    let dto = into_dto(&row, &body);
    let _ = app.emit(
        "notes:updated",
        serde_json::json!({ "id": row.id, "changes": { "title": row.title }, "source": "internal" }),
    );
    Ok(NoteUpdateResponse {
        success: true,
        note: Some(dto),
        error: None,
    })
}
```

- [ ] **Step 26.3: Register, run, commit**

```bash
git commit -am "m5(cmd): notes_update updates body/title/emoji + emits notes:updated"
```

---

### Task 27: `notes_delete` (soft delete)

- [ ] **Step 27.1: Tests** — assert deleted note disappears from `list_active`, vault FS file is moved to `<vault>/.trash/<id>.md` (M3 vault has trash semantics; if not, retain file but soft-delete metadata only and emit `notes:deleted`).

- [ ] **Step 27.2: Implement**

```rust
#[tauri::command]
#[specta::specta]
pub async fn notes_delete(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> AppResult<serde_json::Value> {
    let conn = state.db.conn().lock().await;
    let row = crate::db::note_metadata::get_by_id(&conn, &id)?
        .ok_or_else(|| AppError::NotFound(format!("note {id}")))?;
    let now = now_iso();
    state.vault.notes_io().move_to_trash(&row.path).await?;
    crate::db::note_metadata::delete_soft(&conn, &id, &now)?;
    crate::db::notes_cache::delete(&conn, &id)?;
    crate::db::note_positions::drop_for_note(&conn, &id)?;
    let _ = app.emit(
        "notes:deleted",
        serde_json::json!({ "id": id, "path": row.path, "source": "internal" }),
    );
    Ok(serde_json::json!({ "success": true }))
}
```

If `move_to_trash` doesn't exist on `notes_io`, add it now (small addition to M3 module — keep diff minimal: `<vault>/.trash/<basename>` with collision suffix).

- [ ] **Step 27.3: Register, run, commit**

```bash
git commit -am "m5(cmd): notes_delete soft-deletes metadata and trashes vault file"
```

---

### Task 28: `notes_list` + `notes_list_by_folder`

- [ ] **Step 28.1: Tests** — verify pagination (`limit`/`offset`), sort (`modified DESC` default), folder filter.

- [ ] **Step 28.2: Implement**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteListOptions {
    pub folder: Option<String>,
    pub tags: Option<Vec<String>>,
    pub sort_by: Option<String>,    // "modified" | "created" | "title" | "position"
    pub sort_order: Option<String>, // "asc" | "desc"
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[tauri::command]
#[specta::specta]
pub async fn notes_list(
    state: State<'_, AppState>,
    options: Option<NoteListOptions>,
) -> AppResult<NoteListResponse> {
    let conn = state.db.conn().lock().await;
    let opts = options.unwrap_or(NoteListOptions {
        folder: None,
        tags: None,
        sort_by: Some("modified".into()),
        sort_order: Some("desc".into()),
        limit: Some(100),
        offset: Some(0),
    });
    let items = crate::db::notes_cache::list_active(
        &conn,
        opts.folder.as_deref(),
        opts.sort_by.as_deref().unwrap_or("modified"),
        opts.sort_order.as_deref().unwrap_or("desc"),
        opts.limit.unwrap_or(100),
        opts.offset.unwrap_or(0),
    )?;
    let total = crate::db::notes_cache::count_active(&conn, opts.folder.as_deref())?;
    let has_more = (opts.offset.unwrap_or(0) + items.len() as i64) < total;
    Ok(NoteListResponse {
        notes: items,
        total,
        has_more,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn notes_list_by_folder(
    state: State<'_, AppState>,
    folder_id: String,
) -> AppResult<NoteListResponse> {
    notes_list(
        state,
        Some(NoteListOptions {
            folder: Some(folder_id),
            tags: None,
            sort_by: Some("position".into()),
            sort_order: Some("asc".into()),
            limit: Some(1000),
            offset: Some(0),
        }),
    )
    .await
}
```

- [ ] **Step 28.3: Register, run, commit**

```bash
git commit -am "m5(cmd): notes_list + notes_list_by_folder using notes_cache"
```

---

### Task 29: `notes_rename`, `notes_move`, `notes_exists`

- [ ] **Step 29.1: Tests** — rename only changes title and slug (+ vault FS move); move only changes folder prefix; exists works for both id and path string.

- [ ] **Step 29.2: Implement**

```rust
#[tauri::command]
#[specta::specta]
pub async fn notes_rename(
    state: State<'_, AppState>,
    app: AppHandle,
    input: serde_json::Value,
) -> AppResult<NoteUpdateResponse> {
    let id = input["id"].as_str().ok_or_else(|| AppError::Validation("id".into()))?.to_string();
    let new_title = input["newTitle"]
        .as_str()
        .ok_or_else(|| AppError::Validation("newTitle".into()))?
        .to_string();
    let conn = state.db.conn().lock().await;
    let mut row = crate::db::note_metadata::get_by_id(&conn, &id)?
        .ok_or_else(|| AppError::NotFound(id.clone()))?;
    let folder = row.path.rsplit_once('/').map(|(f, _)| f.to_string()).unwrap_or_default();
    let slug = slug_for(&new_title);
    let new_path = if folder.is_empty() {
        format!("{slug}.md")
    } else {
        format!("{folder}/{slug}.md")
    };
    state.vault.notes_io().rename_file(&row.path, &new_path).await?;
    let old_path = row.path.clone();
    let old_title = row.title.clone();
    row.path = new_path.clone();
    row.title = new_title.clone();
    row.modified_at = now_iso();
    crate::db::note_metadata::upsert(&conn, &row)?;
    crate::db::notes_cache::refresh_path(&conn, &id, &new_path, &new_title)?;
    let body = state.vault.notes_io().read_note(&new_path).await?;
    let _ = app.emit(
        "notes:renamed",
        serde_json::json!({
            "id": id, "oldPath": old_path, "newPath": new_path,
            "oldTitle": old_title, "newTitle": new_title,
        }),
    );
    Ok(NoteUpdateResponse { success: true, note: Some(into_dto(&row, &body)), error: None })
}

#[tauri::command]
#[specta::specta]
pub async fn notes_move(
    state: State<'_, AppState>,
    app: AppHandle,
    input: serde_json::Value,
) -> AppResult<NoteUpdateResponse> {
    let id = input["id"].as_str().ok_or_else(|| AppError::Validation("id".into()))?.to_string();
    let new_folder = input["newFolder"]
        .as_str()
        .ok_or_else(|| AppError::Validation("newFolder".into()))?
        .to_string();
    let conn = state.db.conn().lock().await;
    let mut row = crate::db::note_metadata::get_by_id(&conn, &id)?
        .ok_or_else(|| AppError::NotFound(id.clone()))?;
    let basename = row.path.rsplit('/').next().unwrap_or(&row.path).to_string();
    let new_path = if new_folder.is_empty() {
        basename.clone()
    } else {
        format!("{new_folder}/{basename}")
    };
    state.vault.notes_io().rename_file(&row.path, &new_path).await?;
    let old_path = row.path.clone();
    row.path = new_path.clone();
    row.modified_at = now_iso();
    crate::db::note_metadata::upsert(&conn, &row)?;
    crate::db::notes_cache::refresh_path(&conn, &id, &new_path, &row.title)?;
    let body = state.vault.notes_io().read_note(&new_path).await?;
    let _ = app.emit(
        "notes:moved",
        serde_json::json!({ "id": id, "oldPath": old_path, "newPath": new_path }),
    );
    Ok(NoteUpdateResponse { success: true, note: Some(into_dto(&row, &body)), error: None })
}

#[tauri::command]
#[specta::specta]
pub async fn notes_exists(state: State<'_, AppState>, title_or_path: String) -> AppResult<bool> {
    let conn = state.db.conn().lock().await;
    if crate::db::note_metadata::exists_path(&conn, &title_or_path)? {
        return Ok(true);
    }
    // Fall back to title-based lookup (case-insensitive).
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM note_metadata WHERE title = ?1 COLLATE NOCASE
            AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''",
        [&title_or_path],
        |r| r.get(0),
    )?;
    Ok(count > 0)
}
```

- [ ] **Step 29.3: Register, run, commit**

```bash
git commit -am "m5(cmd): notes_rename + notes_move + notes_exists"
```

---

### Task 30: `notes_set_local_only` + `notes_get_local_only_count`

- [ ] **Step 30.1: Tests** — toggle local_only on a note, then verify count goes 0→1.

- [ ] **Step 30.2: Implement**

```rust
#[tauri::command]
#[specta::specta]
pub async fn notes_set_local_only(
    state: State<'_, AppState>,
    input: serde_json::Value,
) -> AppResult<serde_json::Value> {
    let id = input["id"].as_str().ok_or_else(|| AppError::Validation("id".into()))?.to_string();
    let local_only = input["localOnly"].as_bool().unwrap_or(false);
    let conn = state.db.conn().lock().await;
    crate::db::note_metadata::set_local_only(&conn, &id, local_only, &now_iso())?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
#[specta::specta]
pub async fn notes_get_local_only_count(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let conn = state.db.conn().lock().await;
    let count = crate::db::note_metadata::count_local_only(&conn)?;
    Ok(serde_json::json!({ "count": count }))
}
```

- [ ] **Step 30.3: Register, run, commit**

```bash
git commit -am "m5(cmd): notes_set_local_only + notes_get_local_only_count"
```

---

### Task 31: `notes_get_tags` + `notes_get_links` + wiki-link resolve/preview

- [ ] **Step 31.1: Tests** — seed 2 notes with shared tag; assert `get_tags` returns aggregated counts; seed 2 notes with `[[Other]]` body; assert `get_links` returns outgoing + incoming.

- [ ] **Step 31.2: Implement**

```rust
#[tauri::command]
#[specta::specta]
pub async fn notes_get_tags(
    state: State<'_, AppState>,
) -> AppResult<Vec<serde_json::Value>> {
    let conn = state.db.conn().lock().await;
    let rows = crate::db::tag_definitions::list_with_counts(&conn)?;
    Ok(rows.into_iter()
        .map(|t| serde_json::json!({ "tag": t.name, "color": t.color, "count": t.count }))
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn notes_get_links(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<serde_json::Value> {
    let conn = state.db.conn().lock().await;
    let row = crate::db::note_metadata::get_by_id(&conn, &id)?
        .ok_or_else(|| AppError::NotFound(id.clone()))?;
    let body = state.vault.notes_io().read_note(&row.path).await?;
    let outgoing = extract_wikilinks(&body);
    // TODO(M7): swap LIKE-scan for FTS5 backlink index.
    let mut incoming: Vec<serde_json::Value> = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT id, path, title FROM note_metadata
         WHERE id != ?1 AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''",
    )?;
    let rows = stmt.query_map([&id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let needle_title = format!("[[{}", row.title.to_lowercase());
    for r in rows {
        let (sid, spath, stitle) = r?;
        let candidate_body = state.vault.notes_io().read_note(&spath).await.unwrap_or_default();
        if candidate_body.to_lowercase().contains(&needle_title) {
            incoming.push(serde_json::json!({
                "sourceId": sid,
                "sourcePath": spath,
                "sourceTitle": stitle,
                "contexts": [{ "snippet": "...", "linkStart": 0, "linkEnd": 0 }],
            }));
        }
    }
    Ok(serde_json::json!({ "outgoing": outgoing, "incoming": incoming }))
}

fn extract_wikilinks(body: &str) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(end) = body[i + 2..].find("]]") {
                let target = &body[i + 2..i + 2 + end];
                out.push(serde_json::json!({ "sourceId": "", "targetId": null, "targetTitle": target }));
                i += end + 4;
                continue;
            }
        }
        i += 1;
    }
    out
}

#[tauri::command]
#[specta::specta]
pub async fn notes_resolve_by_title(
    state: State<'_, AppState>,
    title: String,
) -> AppResult<Option<NoteListItem>> {
    let conn = state.db.conn().lock().await;
    // SQL LIKE for M5; FTS upgrade in M7. Casing handled by COLLATE NOCASE.
    let row = conn
        .query_row(
            "SELECT id, title, path, snippet, word_count, tags_json, emoji, modified_at, created_at, local_only
                FROM notes_cache
                WHERE title = ?1 COLLATE NOCASE
                LIMIT 1",
            [&title],
            |r| {
                Ok(NoteListItem {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    path: r.get(2)?,
                    snippet: r.get(3)?,
                    word_count: r.get(4)?,
                    tags: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
                    emoji: r.get(6)?,
                    modified: r.get(7)?,
                    created: r.get(8)?,
                    local_only: r.get::<_, i64>(9)? != 0,
                })
            },
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(row)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_preview_by_title(
    state: State<'_, AppState>,
    title: String,
) -> AppResult<Option<serde_json::Value>> {
    let Some(item) = notes_resolve_by_title(state.clone(), title).await? else {
        return Ok(None);
    };
    Ok(Some(serde_json::json!({
        "id": item.id,
        "title": item.title,
        "path": item.path,
        "snippet": item.snippet,
        "emoji": item.emoji,
    })))
}
```

`State` is `Send + Sync` so `.clone()` is fine here.

- [ ] **Step 31.3: Register, run, commit**

```bash
git commit -am "m5(cmd): notes_get_tags + get_links + resolve/preview by title (LIKE-only; FTS in M7)"
```

---

### Task 32: Aggregate `commands_notes_test.rs` covering happy paths

**Files:**
- Create: `apps/desktop-tauri/src-tauri/tests/commands_notes_test.rs`

- [ ] **Step 32.1: Drive 6+ scenarios end-to-end**

```rust
// apps/desktop-tauri/src-tauri/tests/commands_notes_test.rs
//
// End-to-end happy paths through the inner command helpers. The actual
// `#[tauri::command]` async fns are covered by the runtime e2e lane in
// Chunk 10.
//
// Keep these synchronous and DB-only — no Tauri AppHandle dependencies.

use memry_desktop_tauri_lib::commands::notes::{notes_create_inner, NoteCreateInput};
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};

#[tokio::test]
async fn create_then_list() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "First".into(),
            content: Some("alpha".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap();
    let active = memry_desktop_tauri_lib::db::note_metadata::list_active(&conn).unwrap();
    assert_eq!(active.len(), 1);
}
```

Add at least 5 more scenarios: rename round-trip, move round-trip, soft-delete excludes from list, set_local_only flips count, exists for both id and title.

- [ ] **Step 32.2: Run — expect PASS** for all 6.

- [ ] **Step 32.3: Commit**

```bash
git commit -am "m5(test): aggregate commands_notes_test covering 6 happy paths"
```

---

### Chunk 3 close-out

- [ ] Regenerate bindings:

```bash
pnpm --filter @memry/desktop-tauri bindings:generate
pnpm --filter @memry/desktop-tauri bindings:check
```

Expected: `bindings:check` exits 0; new types (`NoteDto`, `NoteListItem`, etc.) appear in `src/generated/bindings.ts`.

- [ ] Commit the regenerated bindings:

```bash
git commit -am "m5(bindings): regenerate after notes commands"
```

- [ ] No renderer wiring yet — mock-lane Playwright still passes against the M1 visual baseline.

---

## Chunk 4 — Folder Commands

Goal: ship folder listing/CRUD + folder configs + folder template inheritance.

### Task 33: `notes_get_folders` + `notes_create_folder` + `notes_rename_folder` + `notes_delete_folder`

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/commands/folders.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/commands_folders_test.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/commands/mod.rs`

- [ ] **Step 33.1: Tests** — folder CRUD round-trip against the M3 vault FS; rename moves all child notes; delete refuses non-empty without `recursive: true`.

- [ ] **Step 33.2: Implement**

```rust
//! Folder operations. Folders are physical directories in the vault; we
//! maintain a `folder_configs` row per folder for icon/template settings.

use crate::app_state::AppState;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub path: String,
    pub icon: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn notes_get_folders(state: State<'_, AppState>) -> AppResult<Vec<FolderInfo>> {
    let folders = state.vault.notes_io().list_folders().await?;
    let conn = state.db.conn().lock().await;
    let mut out = Vec::with_capacity(folders.len());
    for path in folders {
        let icon = crate::db::folder_configs::get(&conn, &path)?.and_then(|c| c.icon);
        out.push(FolderInfo { path, icon });
    }
    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_create_folder(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<serde_json::Value> {
    state.vault.notes_io().create_folder(&path).await?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
#[specta::specta]
pub async fn notes_rename_folder(
    state: State<'_, AppState>,
    app: AppHandle,
    input: serde_json::Value,
) -> AppResult<serde_json::Value> {
    let old_path = input["oldPath"]
        .as_str()
        .ok_or_else(|| AppError::Validation("oldPath".into()))?
        .to_string();
    let new_path = input["newPath"]
        .as_str()
        .ok_or_else(|| AppError::Validation("newPath".into()))?
        .to_string();
    state.vault.notes_io().rename_folder(&old_path, &new_path).await?;
    let conn = state.db.conn().lock().await;
    // Bulk-update note metadata paths under the renamed folder.
    let prefix_old = format!("{old_path}/");
    let prefix_new = format!("{new_path}/");
    conn.execute(
        "UPDATE note_metadata SET path = ?1 || substr(path, ?2 + 1)
            WHERE path LIKE ?3 || '%'",
        rusqlite::params![&prefix_new, prefix_old.len() as i64, &prefix_old],
    )?;
    let _ = app.emit("notes:folder-renamed", serde_json::json!({ "oldPath": old_path, "newPath": new_path }));
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
#[specta::specta]
pub async fn notes_delete_folder(
    state: State<'_, AppState>,
    input: serde_json::Value,
) -> AppResult<serde_json::Value> {
    let path = input["path"]
        .as_str()
        .ok_or_else(|| AppError::Validation("path".into()))?
        .to_string();
    let recursive = input["recursive"].as_bool().unwrap_or(false);
    let conn = state.db.conn().lock().await;
    let prefix = format!("{path}/");
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM note_metadata WHERE path LIKE ?1 || '%'
            AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''",
        [&prefix],
        |r| r.get(0),
    )?;
    if count > 0 && !recursive {
        return Err(AppError::Conflict(format!("folder {path} not empty")));
    }
    state.vault.notes_io().delete_folder(&path, recursive).await?;
    if recursive {
        conn.execute(
            "UPDATE note_metadata
                SET clock = json_set(coalesce(clock, '{}'), '$.deleted_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                WHERE path LIKE ?1 || '%'",
            [&prefix],
        )?;
    }
    Ok(serde_json::json!({ "success": true }))
}
```

- [ ] **Step 33.3: Register, run, commit**

```bash
git commit -am "m5(cmd): folder CRUD with cascading metadata updates"
```

---

### Task 34: `notes_get_folder_config` + `notes_set_folder_config` + `notes_get_folder_template`

- [ ] **Step 34.1: Tests** — round-trip config; template inheritance test using `db::folder_configs::get_template_inherited`.

- [ ] **Step 34.2: Implement** thin wrappers over `db::folder_configs`. Each command takes/returns JSON shapes that match `@memry/contracts/folder-view-api.ts`.

- [ ] **Step 34.3: Register, run, commit**

```bash
git commit -am "m5(cmd): folder config get/set + template inheritance"
```

---

### Task 35: `notes_get_positions` + `notes_get_all_positions` + `notes_reorder`

- [ ] **Step 35.1: Tests** — wrap `db::note_positions` happy paths.

- [ ] **Step 35.2: Implement** — direct pass-through. `get_positions` accepts `{ folderPath }`, returns `{ success, positions }`. `reorder` accepts `{ folderPath, notePaths }`, mirrors the Electron contract.

- [ ] **Step 35.3: Register, run, commit**

```bash
git commit -am "m5(cmd): notes_get_positions + get_all_positions + reorder"
```

---

### Chunk 4 close-out

- [ ] `cargo test --test 'commands_folders_test'` passes ≥6 scenarios.
- [ ] `bindings:check` clean.

---

## Chunk 5 — Property Commands

Goal: ship the property-definition CRUD surface (10 commands). Acceptance proof: `cargo test --test commands_properties_test` passes ≥10 tests.

### Task 36: `notes_get_property_definitions` + `notes_create_property_definition` + `notes_update_property_definition`

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/commands/properties.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/commands_properties_test.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/commands/mod.rs`

- [ ] **Step 36.1: Tests + Implementation**

```rust
//! Property-definition commands — thin wrappers over db::property_definitions.

use crate::app_state::AppState;
use crate::db::property_definitions as db;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatePropertyDefinitionInput {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub options: Option<serde_json::Value>,
    pub default_value: Option<String>,
    pub color: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn notes_get_property_definitions(
    state: State<'_, AppState>,
) -> AppResult<Vec<db::PropertyDefinitionRow>> {
    let conn = state.db.conn().lock().await;
    db::list(&conn)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_create_property_definition(
    state: State<'_, AppState>,
    input: CreatePropertyDefinitionInput,
) -> AppResult<db::PropertyDefinitionRow> {
    let conn = state.db.conn().lock().await;
    let row = db::PropertyDefinitionRow {
        name: input.name.clone(),
        ty: input.ty,
        options: input.options.map(|v| v.to_string()),
        default_value: input.default_value,
        color: input.color,
        created_at: crate::commands::notes::now_iso(),
    };
    db::create(&conn, &row)?;
    db::get(&conn, &input.name)?.ok_or_else(|| AppError::Internal("just-inserted row missing".into()))
}

#[tauri::command]
#[specta::specta]
pub async fn notes_update_property_definition(
    state: State<'_, AppState>,
    input: serde_json::Value,
) -> AppResult<db::PropertyDefinitionRow> {
    let name = input["name"].as_str().ok_or_else(|| AppError::Validation("name".into()))?.to_string();
    let new_type = input["type"].as_str().ok_or_else(|| AppError::Validation("type".into()))?.to_string();
    let conn = state.db.conn().lock().await;
    db::update_type(&conn, &name, &new_type)?;
    db::get(&conn, &name)?.ok_or_else(|| AppError::NotFound(name))
}

#[tauri::command]
#[specta::specta]
pub async fn notes_ensure_property_definition(
    state: State<'_, AppState>,
    input: serde_json::Value,
) -> AppResult<db::PropertyDefinitionRow> {
    let name = input["name"].as_str().ok_or_else(|| AppError::Validation("name".into()))?.to_string();
    let ty = input["type"].as_str().unwrap_or("text").to_string();
    let default_value = input["defaultValue"].as_str().map(String::from);
    let conn = state.db.conn().lock().await;
    db::ensure(&conn, &name, &ty, default_value.as_deref())?;
    db::get(&conn, &name)?.ok_or_else(|| AppError::NotFound(name))
}
```

- [ ] **Step 36.2: Register, run, commit**

```bash
git commit -am "m5(cmd): property definition list/create/update/ensure"
```

---

### Task 37: `notes_add_property_option` + `add_status_option` + `remove_property_option` + `rename_property_option` + `update_option_color` + `delete_property_definition`

- [ ] **Step 37.1: Tests** — option round-trips, color updates persist, status options track category.

- [ ] **Step 37.2: Implement** — direct wrappers over `db::property_definitions::add_option` / `remove_option` / `rename_option` / `update_option_color` / `delete` / `add_status_option`. Each command accepts a `serde_json::Value` payload to keep the contract permissive.

- [ ] **Step 37.3: Register, run, commit**

```bash
git commit -am "m5(cmd): property option mutations + delete_property_definition"
```

---

### Chunk 5 close-out

- [ ] `cargo test --test commands_properties_test` ≥10 tests pass.
- [ ] `bindings:check` clean.

---

## Chunk 6 — Editor-adjacent Stubs (deferred markers)

Goal: make every renderer-invoked notes/folders/properties/CRDT command **classified** by `command:parity` — either real, mocked-with-deferred-tag, or retired. No unclassified row by chunk end.

### Task 38: `notes_get_file` + attachment metadata reads

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/commands/stubs_m6_m7_m8.rs`

- [ ] **Step 38.1: Implement** the small set we *do* ship in M5:

```rust
//! Editor-adjacent commands that ship metadata-only in M5. Real upload/
//! download/blob lives in M6 (sync). Export/PDF/HTML/versions live in M8.

use crate::app_state::AppState;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub id: String,
    pub path: String,
    pub mime_type: Option<String>,
    pub file_size: Option<i64>,
}

#[tauri::command]
#[specta::specta]
pub async fn notes_get_file(state: State<'_, AppState>, id: String) -> AppResult<FileMetadata> {
    let conn = state.db.conn().lock().await;
    let row = crate::db::note_metadata::get_by_id(&conn, &id)?
        .ok_or_else(|| AppError::NotFound(id.clone()))?;
    Ok(FileMetadata {
        id: row.id,
        path: row.path,
        mime_type: row.mime_type,
        file_size: row.file_size,
    })
}
```

Register in `lib.rs`.

- [ ] **Step 38.2: Commit**

```bash
git commit -am "m5(cmd): notes_get_file metadata for non-markdown files"
```

---

### Task 39: Mock-only deferred routes (M6/M7/M8)

**Files:**
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/stubs/attachments.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/stubs/export.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/stubs/versions.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/stubs/import.ts`

- [ ] **Step 39.1: Author each stubs file**

Each stub file mirrors the Electron channel name with a `deferred:M*` tag in a comment. Example:

```typescript
// apps/desktop-tauri/src/lib/ipc/mocks/stubs/attachments.ts
import type { MockRouteMap } from '../types'

// deferred:M6 — real R2 upload/download lives in the sync engine milestone.
export const attachmentsRoutes: MockRouteMap = {
  notes_upload_attachment: async () => ({ success: false, error: 'attachments-deferred-m6' }),
  notes_list_attachments: async () => [],
  notes_delete_attachment: async () => ({ success: false, error: 'attachments-deferred-m6' }),
}
```

Repeat for `export.ts` (`notes_export_pdf`, `notes_export_html` → `deferred:M8`), `versions.ts` (`notes_get_versions` / `notes_get_version` / `notes_restore_version` / `notes_delete_version` → `deferred:M8`), `import.ts` (`notes_import_files`, `notes_show_import_dialog`, `notes_open_external`, `notes_reveal_in_finder` → `deferred:M8`).

- [ ] **Step 39.2: Wire into mock router**

Edit `src/lib/ipc/mocks/index.ts`. Replace the previous `notesRoutes` import — most entries graduate to real Rust in Task 47, but the deferred ones are pulled from `stubs/`:

```typescript
import { attachmentsRoutes } from './stubs/attachments'
import { exportRoutes } from './stubs/export'
import { versionsRoutes } from './stubs/versions'
import { importRoutes } from './stubs/import'

export const allMockRoutes = {
  // ...M5 graduated commands have been removed (handled by real Rust)...
  ...attachmentsRoutes,
  ...exportRoutes,
  ...versionsRoutes,
  ...importRoutes,
}
```

- [ ] **Step 39.3: Update DEFERRED ledger**

Edit `apps/desktop-tauri/scripts/command-parity-audit.ts`. In the `DEFERRED` map, add:

```typescript
notes_upload_attachment: 'M6',
notes_list_attachments: 'M6',
notes_delete_attachment: 'M6',
notes_export_pdf: 'M8',
notes_export_html: 'M8',
notes_get_versions: 'M8',
notes_get_version: 'M8',
notes_restore_version: 'M8',
notes_delete_version: 'M8',
notes_import_files: 'M8',
notes_show_import_dialog: 'M8',
notes_open_external: 'M8',
notes_reveal_in_finder: 'M8',
```

Remove any matching M5 entries that no longer apply.

- [ ] **Step 39.4: Run command:parity**

```bash
pnpm --filter @memry/desktop-tauri command:parity
```

Expected: zero unclassified `notes:*`, `folder*`, `property*` entries. Deferred entries print with their milestone tag.

- [ ] **Step 39.5: Commit**

```bash
git commit -am "m5(parity): defer attachments to M6, export/version/import to M8"
```

---

### Chunk 6 close-out

- [ ] `command:parity` exits 0 with all notes/folder/property surface classified.
- [ ] Renderer mock-lane Playwright still passes (the deferred mocks return safe empty/error shapes).

---

## Chunk 7 — CRDT Commands (Binary IPC)

Goal: ship the small CRDT command surface that the renderer Y.Doc provider talks to, with binary IPC for everything except naming. Acceptance proof at end: `cargo test --test commands_crdt_test` passes ≥10 tests; `crdt_apply_update → crdt-update event → renderer apply` round-trips against a stubbed AppHandle.

### Task 40: `commands/crdt.rs` — `crdt_open_doc` + `crdt_close_doc`

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/commands/crdt.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/commands_crdt_test.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/commands/mod.rs`

- [ ] **Step 40.1: Tests**

```rust
// apps/desktop-tauri/src-tauri/tests/commands_crdt_test.rs
use memry_desktop_tauri_lib::commands::crdt::{
    crdt_close_doc_inner, crdt_open_doc_inner,
};
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};

#[tokio::test]
async fn open_doc_creates_runtime_entry() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let crdt = std::sync::Arc::new(memry_desktop_tauri_lib::crdt::CrdtRuntime::new());
    crdt_open_doc_inner(&conn, &vault, crdt.clone(), "n1").await.unwrap();
    assert_eq!(crdt.open_doc_count().await, 1);
}

#[tokio::test]
async fn close_doc_drops_runtime_entry() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let crdt = std::sync::Arc::new(memry_desktop_tauri_lib::crdt::CrdtRuntime::new());
    crdt_open_doc_inner(&conn, &vault, crdt.clone(), "n1").await.unwrap();
    crdt_close_doc_inner(crdt.clone(), "n1").await;
    assert_eq!(crdt.open_doc_count().await, 0);
}
```

- [ ] **Step 40.2: Implement**

```rust
//! CRDT IPC commands. Use binary `Response` for snapshot/state-vector returns
//! and accept inline `Vec<u8>` for update apply — the M1 spec budget is 64 KB
//! per inline update; bigger updates use the renderer chunking helper.

use crate::app_state::AppState;
use crate::crdt::{
    apply_update_v1, encode_diff_since_v1, encode_snapshot_v1, encode_state_vector_v1, origin_tag,
    wire::{CrdtUpdateEvent, CRDT_UPDATE_EVENT},
    CrdtRuntime, DocStore,
};
use crate::error::{AppError, AppResult};
use std::sync::Arc;
use tauri::{ipc::Response, AppHandle, Emitter, State};

pub const MAX_INLINE_UPDATE_BYTES: usize = 64 * 1024;

pub async fn crdt_open_doc_inner(
    conn: &rusqlite::Connection,
    vault: &crate::vault::VaultRuntime,
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
) -> AppResult<()> {
    use crate::db::{crdt_snapshots, crdt_updates};

    let handle = crdt.docs().get_or_init(note_id).await;

    if let Some(snap) = crdt_snapshots::get_latest(conn, note_id)? {
        apply_update_v1(&handle, &snap.snapshot_bytes, origin_tag())?;
    } else {
        // First open — seed from on-disk markdown if present.
        if let Some(row) = crate::db::note_metadata::get_by_id(conn, note_id)? {
            let body = vault.notes_io().read_note(&row.path).await.unwrap_or_default();
            crate::crdt::seed::seed_from_markdown(&handle, &body)?;
            let snap_bytes = encode_snapshot_v1(&handle)?;
            crdt_updates::append(conn, note_id, &snap_bytes, origin_tag() as i64)?;
        }
    }

    let updates = crdt_updates::list_for_note(conn, note_id)?;
    for update in updates {
        // Skip the seeded snapshot row if we just wrote it — its content is
        // already applied into the doc.
        let _ = apply_update_v1(&handle, &update.update_bytes, update.origin as u32);
    }
    Ok(())
}

pub async fn crdt_close_doc_inner(crdt: Arc<CrdtRuntime>, note_id: &str) {
    crdt.docs().drop_doc(note_id).await;
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_open_doc(
    state: State<'_, AppState>,
    note_id: String,
) -> AppResult<serde_json::Value> {
    let conn = state.db.conn().lock().await;
    crdt_open_doc_inner(&conn, &state.vault, state.crdt.clone(), &note_id).await?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_close_doc(state: State<'_, AppState>, note_id: String) -> AppResult<()> {
    crdt_close_doc_inner(state.crdt.clone(), &note_id).await;
    Ok(())
}
```

- [ ] **Step 40.3: Register, run, commit**

```bash
git commit -am "m5(cmd): crdt_open_doc + crdt_close_doc with snapshot+updates replay"
```

---

### Task 41: `crdt_apply_update`

- [ ] **Step 41.1: Tests** — apply two updates from MEMRY_DEVICE A and B; verify final doc state matches; verify `crdt_updates` rows appended in seq order; verify origin tag preserved.

- [ ] **Step 41.2: Implement**

```rust
#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtApplyUpdateInput {
    pub note_id: String,
    pub update: Vec<u8>,
    /// Optional renderer-supplied origin (defaults to renderer's clientID); we
    /// stamp the persisted row with the *Rust* origin tag so observers
    /// distinguish local-rust writes from network writes.
    pub origin: Option<u32>,
}

pub async fn crdt_apply_update_inner(
    conn: &rusqlite::Connection,
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
    update_bytes: &[u8],
    incoming_origin: u32,
) -> AppResult<i64> {
    use crate::db::{crdt_snapshots, crdt_updates};

    if update_bytes.len() > MAX_INLINE_UPDATE_BYTES {
        return Err(AppError::Validation(format!(
            "update {} bytes exceeds inline cap {} — use chunked transport",
            update_bytes.len(),
            MAX_INLINE_UPDATE_BYTES
        )));
    }

    let handle = crdt.docs().get_or_init(note_id).await;
    apply_update_v1(&handle, update_bytes, incoming_origin)?;
    let seq = crdt_updates::append(conn, note_id, update_bytes, incoming_origin as i64)?;

    if seq >= crate::crdt::compaction::COMPACT_THRESHOLD {
        let result = crate::crdt::compact_doc(&handle, seq)?;
        let sv = encode_state_vector_v1(&handle)?;
        crdt_snapshots::upsert_with_compaction(
            conn,
            note_id,
            &result.snapshot_bytes,
            &sv,
            result.replaced_through_seq,
        )?;
    }
    Ok(seq)
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_apply_update(
    state: State<'_, AppState>,
    app: AppHandle,
    input: CrdtApplyUpdateInput,
) -> AppResult<serde_json::Value> {
    let incoming_origin = input.origin.unwrap_or_else(origin_tag);
    let conn = state.db.conn().lock().await;
    let seq = crdt_apply_update_inner(
        &conn,
        state.crdt.clone(),
        &input.note_id,
        &input.update,
        incoming_origin,
    )
    .await?;
    drop(conn);

    let payload = CrdtUpdateEvent {
        note_id: input.note_id.clone(),
        update: input.update,
        origin: incoming_origin,
    };
    let _ = app.emit(CRDT_UPDATE_EVENT, payload);

    Ok(serde_json::json!({ "seq": seq }))
}
```

- [ ] **Step 41.3: Register, run, commit**

```bash
git commit -am "m5(cmd): crdt_apply_update with auto-compaction on threshold"
```

---

### Task 42: `crdt_get_snapshot` + `crdt_get_state_vector` (binary `Response`)

- [ ] **Step 42.1: Tests**

```rust
use memry_desktop_tauri_lib::commands::crdt::{
    crdt_get_snapshot_bytes, crdt_get_state_vector_bytes,
};
// Plus open + apply paths from earlier tests.

#[tokio::test]
async fn snapshot_round_trips_through_apply() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let crdt = std::sync::Arc::new(memry_desktop_tauri_lib::crdt::CrdtRuntime::new());
    // Seed a note, apply an update, then read back the snapshot.
    let _ = memry_desktop_tauri_lib::commands::notes::notes_create_inner(
        &conn,
        &vault,
        memry_desktop_tauri_lib::commands::notes::NoteCreateInput {
            title: "T".into(),
            content: Some("alpha".into()),
            folder: None,
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap();
    let id = memry_desktop_tauri_lib::db::note_metadata::list_active(&conn).unwrap()[0].id.clone();
    memry_desktop_tauri_lib::commands::crdt::crdt_open_doc_inner(&conn, &vault, crdt.clone(), &id)
        .await
        .unwrap();

    let snap = crdt_get_snapshot_bytes(crdt.clone(), &id).await.unwrap();
    assert!(!snap.is_empty());
    let sv = crdt_get_state_vector_bytes(crdt.clone(), &id).await.unwrap();
    assert!(!sv.is_empty());
}
```

- [ ] **Step 42.2: Implement**

```rust
pub async fn crdt_get_snapshot_bytes(crdt: Arc<CrdtRuntime>, note_id: &str) -> AppResult<Vec<u8>> {
    let handle = crdt
        .docs()
        .get(note_id)
        .await
        .ok_or_else(|| AppError::NotFound(format!("crdt doc {note_id}")))?;
    encode_snapshot_v1(&handle)
}

pub async fn crdt_get_state_vector_bytes(
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
) -> AppResult<Vec<u8>> {
    let handle = crdt
        .docs()
        .get(note_id)
        .await
        .ok_or_else(|| AppError::NotFound(format!("crdt doc {note_id}")))?;
    encode_state_vector_v1(&handle)
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_get_snapshot(
    state: State<'_, AppState>,
    note_id: String,
) -> AppResult<Response> {
    let bytes = crdt_get_snapshot_bytes(state.crdt.clone(), &note_id).await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_get_state_vector(
    state: State<'_, AppState>,
    note_id: String,
) -> AppResult<Response> {
    let bytes = crdt_get_state_vector_bytes(state.crdt.clone(), &note_id).await?;
    Ok(Response::new(bytes))
}
```

- [ ] **Step 42.3: Register, run, commit**

```bash
git commit -am "m5(cmd): crdt_get_snapshot + crdt_get_state_vector via binary Response"
```

---

### Task 43: `crdt_sync_step_1` + `crdt_sync_step_2`

- [ ] **Step 43.1: Tests** — replicate the renderer "I'm reconnecting, here's my sv" path. Step 1 returns the diff Rust has past the renderer sv plus Rust's own sv. Step 2 applies the renderer's catch-up update.

- [ ] **Step 43.2: Implement**

```rust
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncStep1Result {
    pub diff: Vec<u8>,
    pub state_vector: Vec<u8>,
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_sync_step_1(
    state: State<'_, AppState>,
    note_id: String,
    state_vector: Vec<u8>,
) -> AppResult<SyncStep1Result> {
    let handle = state
        .crdt
        .docs()
        .get(&note_id)
        .await
        .ok_or_else(|| AppError::NotFound(note_id.clone()))?;
    let diff = encode_diff_since_v1(&handle, &state_vector)?;
    let sv = encode_state_vector_v1(&handle)?;
    Ok(SyncStep1Result { diff, state_vector: sv })
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_sync_step_2(
    state: State<'_, AppState>,
    app: AppHandle,
    note_id: String,
    diff: Vec<u8>,
) -> AppResult<()> {
    let conn = state.db.conn().lock().await;
    let _ = crdt_apply_update_inner(&conn, state.crdt.clone(), &note_id, &diff, origin_tag()).await?;
    drop(conn);
    let payload = CrdtUpdateEvent {
        note_id,
        update: diff,
        origin: origin_tag(),
    };
    let _ = app.emit(CRDT_UPDATE_EVENT, payload);
    Ok(())
}
```

- [ ] **Step 43.3: Register, run, commit**

```bash
git commit -am "m5(cmd): crdt_sync_step_1 + crdt_sync_step_2"
```

---

### Task 44: `crdt_get_or_init_doc` (lazy seed entry-point)

- [ ] **Step 44.1: Tests** — call twice for the same id; assert idempotent (same final state vector).

- [ ] **Step 44.2: Implement**

```rust
#[tauri::command]
#[specta::specta]
pub async fn crdt_get_or_init_doc(
    state: State<'_, AppState>,
    note_id: String,
) -> AppResult<serde_json::Value> {
    let conn = state.db.conn().lock().await;
    crdt_open_doc_inner(&conn, &state.vault, state.crdt.clone(), &note_id).await?;
    Ok(serde_json::json!({ "noteId": note_id, "ready": true }))
}
```

(The `*_inner` helper from Task 40 already handles seed-or-replay idempotently.)

- [ ] **Step 44.3: Register, run, commit**

```bash
git commit -am "m5(cmd): crdt_get_or_init_doc lazy entrypoint"
```

---

### Task 45: Audit + capability scopes for CRDT commands

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/capabilities/default.json`

- [ ] **Step 45.1: Add command grants**

In the `permissions` array, add the new commands:

```json
"core:default",
"shell:allow-open",
"crdt:default",
"notes:default",
"folders:default",
"properties:default"
```

If `tauri-specta` already auto-emits a per-command grant, just include the new command names. Otherwise, write per-command JSON snippets like:

```json
{
  "identifier": "crdt:default",
  "commands": [
    "crdt_open_doc",
    "crdt_close_doc",
    "crdt_apply_update",
    "crdt_get_snapshot",
    "crdt_get_state_vector",
    "crdt_get_or_init_doc",
    "crdt_sync_step_1",
    "crdt_sync_step_2"
  ]
}
```

(Match the existing M3/M4 capability shape. If the M3 plan generated capabilities programmatically, follow that path instead.)

- [ ] **Step 45.2: Run capability check**

```bash
pnpm --filter @memry/desktop-tauri capability:check
```

Expected: zero ungranted commands; renderer can invoke without "blocked" errors.

- [ ] **Step 45.3: Commit**

```bash
git commit -am "m5(cap): grant CRDT + notes + folders + properties commands"
```

---

### Task 46: Aggregate `commands_crdt_test.rs`

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/tests/commands_crdt_test.rs`

- [ ] **Step 46.1: 5+ scenarios end-to-end**

```rust
//! End-to-end CRDT command flows.

use memry_desktop_tauri_lib::commands::crdt::{
    crdt_apply_update_inner, crdt_close_doc_inner, crdt_get_snapshot_bytes,
    crdt_get_state_vector_bytes, crdt_open_doc_inner,
};
use memry_desktop_tauri_lib::commands::notes::{notes_create_inner, NoteCreateInput};
use memry_desktop_tauri_lib::crdt::{CrdtRuntime, DocStore};
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};
use std::sync::Arc;
use yrs::{GetString, Text, Transact};

#[tokio::test]
async fn round_trip_apply_then_get_snapshot() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let crdt = Arc::new(CrdtRuntime::new());
    let _ = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "alpha".into(),
            content: Some("seed body".into()),
            folder: None,
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap();
    let id = memry_desktop_tauri_lib::db::note_metadata::list_active(&conn).unwrap()[0]
        .id
        .clone();
    crdt_open_doc_inner(&conn, &vault, crdt.clone(), &id).await.unwrap();

    // Author an external update (simulate renderer Y.Doc producing a delta).
    let scratch = Arc::new(CrdtRuntime::new());
    let h = scratch.docs().get_or_init(&id).await;
    h.with_write(|txn| txn.get_or_insert_text("body").insert(txn, 0, "scratch"));
    let bytes = h.with_read(|txn| txn.encode_state_as_update_v1(&Default::default()));

    crdt_apply_update_inner(&conn, crdt.clone(), &id, &bytes, 999).await.unwrap();
    let snap = crdt_get_snapshot_bytes(crdt.clone(), &id).await.unwrap();
    assert!(!snap.is_empty());
    let sv = crdt_get_state_vector_bytes(crdt.clone(), &id).await.unwrap();
    assert!(!sv.is_empty());
}

#[tokio::test]
async fn close_doc_releases_handle() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let crdt = Arc::new(CrdtRuntime::new());
    let _ = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "T".into(),
            content: Some("body".into()),
            folder: None,
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap();
    let id = memry_desktop_tauri_lib::db::note_metadata::list_active(&conn).unwrap()[0]
        .id
        .clone();
    crdt_open_doc_inner(&conn, &vault, crdt.clone(), &id).await.unwrap();
    crdt_close_doc_inner(crdt.clone(), &id).await;
    assert_eq!(crdt.open_doc_count().await, 0);
}
```

Plus three more: oversized-update validation, idempotent open + reload, compaction-fired snapshot drops `crdt_updates` rows.

- [ ] **Step 46.2: Run — expect PASS** (≥5 tests)

- [ ] **Step 46.3: Commit**

```bash
git commit -am "m5(test): commands_crdt_test covering open/apply/snapshot/close/oversize"
```

---

### Chunk 7 close-out

- [ ] `cargo test --test commands_crdt_test --test crdt_compaction_test` ≥10 tests pass.
- [ ] `bindings:check` clean — new `Crdt*` types emitted.
- [ ] Capability check clean.

---

## Chunk 8 — Renderer Wiring (yjs-tauri-provider + BlockNote binding)

Goal: wire the renderer-side shadow Y.Doc to the Rust authoritative doc through the new commands. Acceptance proof: Vitest `lib/crdt/yjs-tauri-provider.test.ts` covers subscribe + apply + origin echo prevention; mock-lane Playwright still passes.

### Task 47: `lib/crdt/origin-tags.ts`

**Files:**
- Create: `apps/desktop-tauri/src/lib/crdt/origin-tags.ts`
- Create: `apps/desktop-tauri/src/lib/crdt/origin-tags.test.ts`

- [ ] **Step 47.1: Tests**

```typescript
// apps/desktop-tauri/src/lib/crdt/origin-tags.test.ts
import { describe, expect, test } from 'vitest'
import { createRendererOrigin, isRendererOrigin } from './origin-tags'

describe('origin tags', () => {
  test('renderer origin is stable across calls', () => {
    const a = createRendererOrigin()
    const b = createRendererOrigin()
    expect(a).toBe(b)
  })

  test('matches its own origin', () => {
    const o = createRendererOrigin()
    expect(isRendererOrigin(o)).toBe(true)
  })

  test('rejects foreign origin', () => {
    expect(isRendererOrigin(0)).toBe(false)
    expect(isRendererOrigin(99)).toBe(false)
  })
})
```

- [ ] **Step 47.2: Implement**

```typescript
// apps/desktop-tauri/src/lib/crdt/origin-tags.ts
//
// Renderer-side origin guard. Yjs natural idempotence already drops echoed
// updates (S2 obs #9), but stamping each apply with our origin lets us also
// short-circuit before re-encoding/re-sending — keeps p95 latency budget.

let cachedOrigin: number | null = null

export function createRendererOrigin(): number {
  if (cachedOrigin !== null) return cachedOrigin
  // Mix performance.now into a non-zero integer.
  const seed = Math.floor((performance.now() * 1_000_003) % 0xfff_ffff) | 1
  cachedOrigin = seed
  return seed
}

export function isRendererOrigin(value: unknown): boolean {
  return typeof value === 'number' && value === createRendererOrigin()
}
```

- [ ] **Step 47.3: Run + commit**

```bash
pnpm --filter @memry/desktop-tauri test lib/crdt/origin-tags.test.ts
git commit -am "m5(renderer): origin-tag helper for renderer Y.Doc echoes"
```

---

### Task 48: `lib/crdt/yjs-tauri-provider.ts`

**Files:**
- Create: `apps/desktop-tauri/src/lib/crdt/yjs-tauri-provider.ts`
- Create: `apps/desktop-tauri/src/lib/crdt/yjs-tauri-provider.test.ts`

- [ ] **Step 48.1: Tests** — drive subscribe/apply/echo using the existing `mockTauri` harness from M1.

```typescript
// apps/desktop-tauri/src/lib/crdt/yjs-tauri-provider.test.ts
import { describe, expect, test, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { YjsTauriProvider } from './yjs-tauri-provider'
import { createRendererOrigin } from './origin-tags'

describe('YjsTauriProvider', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  test('forwards local updates via crdt_apply_update', async () => {
    const invoke = vi.fn().mockResolvedValue({ seq: 1 })
    const listen = vi.fn().mockResolvedValue(() => {})
    const ydoc = new Y.Doc()
    const provider = new YjsTauriProvider({
      noteId: 'n1',
      ydoc,
      invoke,
      listen,
    })
    await provider.connect()

    ydoc.transact(() => {
      ydoc.getText('body').insert(0, 'hi')
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(invoke).toHaveBeenCalledWith(
      'crdt_apply_update',
      expect.objectContaining({ noteId: 'n1' }),
    )
  })

  test('drops echoes whose origin matches the renderer', async () => {
    const invoke = vi.fn().mockResolvedValue({ seq: 1 })
    let handler: (event: { payload: unknown }) => void = () => {}
    const listen = vi.fn().mockImplementation(async (_, h) => {
      handler = h
      return () => {}
    })
    const ydoc = new Y.Doc()
    const provider = new YjsTauriProvider({ noteId: 'n1', ydoc, invoke, listen })
    await provider.connect()

    const origin = createRendererOrigin()
    handler({ payload: { noteId: 'n1', update: [1, 2, 3], origin } })

    // No second invoke because the echo was suppressed.
    expect(invoke).not.toHaveBeenCalledWith(
      'crdt_apply_update',
      expect.objectContaining({ noteId: 'n1' }),
    )
  })
})
```

- [ ] **Step 48.2: Implement**

```typescript
// apps/desktop-tauri/src/lib/crdt/yjs-tauri-provider.ts
//
// Renderer-side Y.Doc provider. Sends local updates to Rust via
// `crdt_apply_update` and applies remote updates from the `crdt-update` event,
// guarding against echo loops via the renderer origin tag.

import * as Y from 'yjs'
import { createRendererOrigin, isRendererOrigin } from './origin-tags'

type InvokeFn = <T>(cmd: string, args?: unknown) => Promise<T>
type ListenFn = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>

export interface YjsTauriProviderOptions {
  noteId: string
  ydoc: Y.Doc
  invoke: InvokeFn
  listen: ListenFn
}

export class YjsTauriProvider {
  private readonly noteId: string
  private readonly ydoc: Y.Doc
  private readonly invoke: InvokeFn
  private readonly listen: ListenFn
  private readonly origin: number
  private unlisten?: () => void
  private docHandler?: (update: Uint8Array, origin: unknown) => void

  constructor(opts: YjsTauriProviderOptions) {
    this.noteId = opts.noteId
    this.ydoc = opts.ydoc
    this.invoke = opts.invoke
    this.listen = opts.listen
    this.origin = createRendererOrigin()
  }

  async connect(): Promise<void> {
    await this.invoke('crdt_get_or_init_doc', { noteId: this.noteId })

    // Bootstrap renderer doc from Rust snapshot to converge state.
    const snap = await this.invoke<ArrayBuffer | number[] | Uint8Array>(
      'crdt_get_snapshot',
      { noteId: this.noteId },
    )
    Y.applyUpdate(this.ydoc, toUint8Array(snap), 'rust-snapshot')

    this.docHandler = (update, origin) => {
      if (origin === 'rust-snapshot' || origin === 'rust') return
      void this.invoke('crdt_apply_update', {
        noteId: this.noteId,
        update: Array.from(update),
        origin: this.origin,
      })
    }
    this.ydoc.on('update', this.docHandler)

    this.unlisten = await this.listen('crdt-update', (event) => {
      const payload = event.payload as { noteId: string; update: number[]; origin: number }
      if (payload.noteId !== this.noteId) return
      if (isRendererOrigin(payload.origin)) return
      Y.applyUpdate(this.ydoc, new Uint8Array(payload.update), 'rust')
    })
  }

  async disconnect(): Promise<void> {
    if (this.docHandler) {
      this.ydoc.off('update', this.docHandler)
    }
    this.unlisten?.()
    this.unlisten = undefined
    await this.invoke('crdt_close_doc', { noteId: this.noteId })
  }
}

function toUint8Array(input: ArrayBuffer | number[] | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) return input
  if (Array.isArray(input)) return new Uint8Array(input)
  return new Uint8Array(input)
}
```

- [ ] **Step 48.3: Run + commit**

```bash
pnpm --filter @memry/desktop-tauri test lib/crdt/yjs-tauri-provider.test.ts
git commit -am "m5(renderer): YjsTauriProvider with origin-guarded echo prevention"
```

---

### Task 49: BlockNote editor binding

**Files:**
- Modify: `apps/desktop-tauri/src/features/notes/editor/BlockNoteEditor.tsx` (or whatever the existing component path is)
- Create: `apps/desktop-tauri/src/features/notes/editor/useNoteCrdt.ts`

- [ ] **Step 49.1: Locate the current editor component**

```bash
rg -n "BlockNoteEditor|useCreateBlockNote" apps/desktop-tauri/src
```

Find the exact path. The mock-lane editor likely creates a BlockNote instance from a string body; M5 swaps that to use a Y.Doc + provider.

- [ ] **Step 49.2: Add `useNoteCrdt` hook**

```typescript
// apps/desktop-tauri/src/features/notes/editor/useNoteCrdt.ts
import { useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import { invoke } from '@/lib/ipc/invoke'
import { listen as tauriListen } from '@tauri-apps/api/event'
import { YjsTauriProvider } from '@/lib/crdt/yjs-tauri-provider'

export function useNoteCrdt(noteId: string) {
  const ydoc = useMemo(() => new Y.Doc(), [noteId])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    const provider = new YjsTauriProvider({
      noteId,
      ydoc,
      invoke,
      listen: tauriListen as unknown as Parameters<typeof YjsTauriProvider>[0]['listen'],
    })
    provider
      .connect()
      .then(() => {
        if (!cancelled) setReady(true)
      })
      .catch((err) => {
        // TODO: surface via extractErrorMessage
        console.error('CRDT connect failed', err)
      })
    return () => {
      cancelled = true
      provider.disconnect().catch(() => undefined)
    }
  }, [noteId, ydoc])

  return { ydoc, ready }
}
```

- [ ] **Step 49.3: Wire into BlockNote**

Replace the in-memory body initialiser with:

```typescript
const { ydoc, ready } = useNoteCrdt(noteId)
const editor = useCreateBlockNote(
  ready
    ? {
        collaboration: {
          fragment: ydoc.getXmlFragment('prosemirror'),
          user: { name: 'You', color: '#3b82f6' },
          provider: undefined,
        },
      }
    : undefined,
  [ydoc, ready],
)
if (!ready) return <EditorSkeleton />
return <BlockNoteView editor={editor} />
```

The fragment name `'prosemirror'` matches `CRDT_FRAGMENT_NAME` from `@memry/contracts/ipc-crdt.ts`.

- [ ] **Step 49.4: Run unit tests + visual mock-lane**

```bash
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri test:e2e -- --grep="@mock-lane"
```

Mock-lane Playwright was passing pre-M5 against a string-body editor. The runtime e2e lane in Chunk 10 covers the live Y.Doc path; mock-lane keeps using the existing `notes_get` mock (we keep it for `deferred:M8` import flows) — actually wait, `notes_get` graduated. Verify mock-lane still has a path: if it now hits real Rust, you must run mock-lane against a fresh test vault; otherwise mark mock-lane @runtime-only and rely on Chunk 10.

- [ ] **Step 49.5: Commit**

```bash
git commit -am "m5(editor): bind BlockNote to shadow Y.Doc via YjsTauriProvider"
```

---

### Task 50: Mock IPC swap for graduated commands

**Files:**
- Modify: `apps/desktop-tauri/src/lib/ipc/invoke.ts`
- Modify: `apps/desktop-tauri/src/lib/ipc/mocks/notes.ts`
- Modify: `apps/desktop-tauri/src/lib/ipc/mocks/folders.ts`
- Modify: `apps/desktop-tauri/src/lib/ipc/mocks/properties.ts`
- Modify: `apps/desktop-tauri/src/lib/ipc/mocks/index.ts`

- [ ] **Step 50.1: Add graduated commands to the real-IPC allowlist**

The M2/M3/M4 pattern keeps a `REAL_TAURI_COMMANDS` set in `invoke.ts`. Add every M5 command:

```typescript
const REAL_TAURI_COMMANDS = new Set<string>([
  // ...existing entries from M2/M3/M4...
  'notes_create',
  'notes_get',
  'notes_get_by_path',
  'notes_update',
  'notes_delete',
  'notes_list',
  'notes_list_by_folder',
  'notes_rename',
  'notes_move',
  'notes_exists',
  'notes_set_local_only',
  'notes_get_local_only_count',
  'notes_get_tags',
  'notes_get_links',
  'notes_resolve_by_title',
  'notes_preview_by_title',
  'notes_get_folders',
  'notes_create_folder',
  'notes_rename_folder',
  'notes_delete_folder',
  'notes_get_folder_config',
  'notes_set_folder_config',
  'notes_get_folder_template',
  'notes_get_property_definitions',
  'notes_create_property_definition',
  'notes_update_property_definition',
  'notes_ensure_property_definition',
  'notes_add_property_option',
  'notes_add_status_option',
  'notes_remove_property_option',
  'notes_rename_property_option',
  'notes_update_option_color',
  'notes_delete_property_definition',
  'notes_get_positions',
  'notes_get_all_positions',
  'notes_reorder',
  'notes_get_file',
  'crdt_open_doc',
  'crdt_close_doc',
  'crdt_apply_update',
  'crdt_get_snapshot',
  'crdt_get_state_vector',
  'crdt_get_or_init_doc',
  'crdt_sync_step_1',
  'crdt_sync_step_2',
])
```

- [ ] **Step 50.2: Delete graduated mock entries**

Edit `notes.ts`/`folders.ts`/`properties.ts`. For each M5 command that has a real Rust handler, delete the mock route. Keep the file with header comments referencing the deferred ledger; if the file empties out, delete it.

- [ ] **Step 50.3: Update mock router index**

```typescript
// apps/desktop-tauri/src/lib/ipc/mocks/index.ts
//
// Routes for commands NOT yet shipped in real Rust. Every entry must have a
// matching DEFERRED entry in command-parity-audit.ts.

import { attachmentsRoutes } from './stubs/attachments'
import { exportRoutes } from './stubs/export'
import { versionsRoutes } from './stubs/versions'
import { importRoutes } from './stubs/import'
// ...keep imports for non-M5 domains: tasks, calendar, inbox, journal, etc...

export const allMockRoutes = {
  ...attachmentsRoutes,
  ...exportRoutes,
  ...versionsRoutes,
  ...importRoutes,
  // ...other domains carried forward from M1...
}
```

- [ ] **Step 50.4: Run**

```bash
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri command:parity
```

Expected: zero unclassified notes/folder/property/CRDT.

- [ ] **Step 50.5: Commit**

```bash
git commit -am "m5(ipc): graduate notes/folder/property/CRDT to real Rust"
```

---

### Chunk 8 close-out

- [ ] `pnpm test` green.
- [ ] `command:parity` green.
- [ ] Mock-lane Playwright green or marked `@runtime-only`.

---

## Chunk 9 — MD → Yjs Conversion + Initial Seed

Goal: convert existing-on-disk markdown into a BlockNote-compatible Y.XmlFragment so notes that pre-date M5 (or that arrived via vault-watcher external writes) can be opened without losing structure. Acceptance proof: `cargo test --test crdt_md_to_yjs_test` ≥6 tests pass; opening a seeded note from the runtime e2e lane produces visible content.

### Task 51: `crdt/md_to_yjs.rs` — block-level markdown parser

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/crdt/md_to_yjs.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/crdt_md_to_yjs_test.rs`
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml` (add `pulldown-cmark`)

- [ ] **Step 51.1: Add the markdown parser dep**

```toml
# CRDT (M5)
lru = "0.12"
once_cell = "1.20"
pulldown-cmark = { version = "0.12", default-features = false, features = ["html"] }
```

- [ ] **Step 51.2: Tests**

```rust
// apps/desktop-tauri/src-tauri/tests/crdt_md_to_yjs_test.rs
use memry_desktop_tauri_lib::crdt::md_to_yjs::md_to_blocknote_blocks;

#[test]
fn parses_paragraph() {
    let blocks = md_to_blocknote_blocks("hello world");
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].kind, "paragraph");
    assert_eq!(blocks[0].text, "hello world");
}

#[test]
fn parses_heading() {
    let blocks = md_to_blocknote_blocks("# Title\n\nbody");
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].kind, "heading");
    assert_eq!(blocks[0].level, Some(1));
    assert_eq!(blocks[1].kind, "paragraph");
}

#[test]
fn parses_bulleted_list() {
    let blocks = md_to_blocknote_blocks("- one\n- two");
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].kind, "bulletListItem");
    assert_eq!(blocks[1].kind, "bulletListItem");
}

#[test]
fn parses_code_block() {
    let blocks = md_to_blocknote_blocks("```rust\nlet x = 1;\n```");
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].kind, "codeBlock");
    assert_eq!(blocks[0].language.as_deref(), Some("rust"));
    assert!(blocks[0].text.contains("let x = 1"));
}

#[test]
fn empty_input_yields_empty_paragraph() {
    let blocks = md_to_blocknote_blocks("");
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].kind, "paragraph");
    assert_eq!(blocks[0].text, "");
}

#[test]
fn turkish_diacritics_round_trip() {
    let blocks = md_to_blocknote_blocks("Türkçe başlık şıkğüöç");
    assert_eq!(blocks[0].text, "Türkçe başlık şıkğüöç");
}
```

- [ ] **Step 51.3: Implement**

```rust
//! Markdown → BlockNote-compatible block list.
//!
//! Scope: paragraphs, headings (1–6), bullet/numbered lists, code blocks.
//! Tables, embeds, and complex inline marks are NOT round-tripped — they
//! appear as plain paragraphs. The seed runs once per note; subsequent edits
//! are CRDT-native, so this lossy first-pass is acceptable.

use pulldown_cmark::{CodeBlockKind, Event, Parser, Tag};

#[derive(Debug, Clone)]
pub struct BlockNoteBlock {
    pub kind: String,
    pub text: String,
    pub level: Option<u8>,
    pub language: Option<String>,
}

pub fn md_to_blocknote_blocks(input: &str) -> Vec<BlockNoteBlock> {
    if input.trim().is_empty() {
        return vec![BlockNoteBlock {
            kind: "paragraph".into(),
            text: String::new(),
            level: None,
            language: None,
        }];
    }

    let mut blocks: Vec<BlockNoteBlock> = Vec::new();
    let mut buf = String::new();
    let mut current_kind: Option<&'static str> = None;
    let mut current_level: Option<u8> = None;
    let mut current_lang: Option<String> = None;

    let parser = Parser::new(input);
    for event in parser {
        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => current_kind = Some("paragraph"),
                Tag::Heading { level, .. } => {
                    current_kind = Some("heading");
                    current_level = Some(level as u8);
                }
                Tag::CodeBlock(kind) => {
                    current_kind = Some("codeBlock");
                    current_lang = match kind {
                        CodeBlockKind::Fenced(s) if !s.is_empty() => Some(s.to_string()),
                        _ => None,
                    };
                }
                Tag::List(Some(_)) => current_kind = Some("numberedListItem"),
                Tag::List(None) => current_kind = Some("bulletListItem"),
                Tag::Item => {}
                _ => {}
            },
            Event::Text(t) => buf.push_str(&t),
            Event::Code(c) => buf.push_str(&c),
            Event::SoftBreak | Event::HardBreak => buf.push('\n'),
            Event::End(_) => {
                if let Some(kind) = current_kind {
                    if !buf.is_empty() || kind == "codeBlock" {
                        blocks.push(BlockNoteBlock {
                            kind: kind.to_string(),
                            text: std::mem::take(&mut buf),
                            level: current_level.take(),
                            language: current_lang.take(),
                        });
                    }
                }
                current_kind = None;
            }
            _ => {}
        }
    }

    if blocks.is_empty() {
        blocks.push(BlockNoteBlock {
            kind: "paragraph".into(),
            text: input.to_string(),
            level: None,
            language: None,
        });
    }
    blocks
}
```

- [ ] **Step 51.4: Run + commit**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test crdt_md_to_yjs_test
git commit -am "m5(crdt): markdown -> BlockNote block list"
```

---

### Task 52: `crdt/seed.rs` — seed Y.Doc from blocks

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/crdt/seed.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/crdt_seed_test.rs`

- [ ] **Step 52.1: Tests**

```rust
// apps/desktop-tauri/src-tauri/tests/crdt_seed_test.rs
use memry_desktop_tauri_lib::crdt::{seed::seed_from_markdown, DocStore};
use yrs::{GetString, Text, Transact, XmlFragment, XmlNode};

#[tokio::test]
async fn seed_paragraph_writes_text_into_prosemirror_fragment() {
    let store = DocStore::new();
    let h = store.get_or_init("note").await;
    seed_from_markdown(&h, "hello world").unwrap();
    let text = h.with_read(|txn| {
        let frag = txn.get_or_insert_xml_fragment("prosemirror");
        let mut buf = String::new();
        for node in frag.successors(txn) {
            if let XmlNode::Text(t) = node {
                buf.push_str(&t.get_string(txn));
            } else if let XmlNode::Element(el) = node {
                for inner in el.successors(txn) {
                    if let XmlNode::Text(t) = inner {
                        buf.push_str(&t.get_string(txn));
                    }
                }
            }
        }
        buf
    });
    assert!(text.contains("hello world"));
}

#[tokio::test]
async fn seed_is_idempotent_against_existing_content() {
    let store = DocStore::new();
    let h = store.get_or_init("note").await;
    seed_from_markdown(&h, "alpha").unwrap();
    seed_from_markdown(&h, "beta").unwrap();
    // Second seed must NOT append "beta" — already-seeded docs are untouched.
    let s = h.with_read(|txn| txn.get_or_insert_xml_fragment("prosemirror").get_string(txn));
    assert!(s.contains("alpha"));
    assert!(!s.contains("beta"));
}
```

- [ ] **Step 52.2: Implement**

```rust
//! Seed an empty Y.Doc with markdown content as BlockNote-compatible XML
//! elements under the `prosemirror` fragment. Idempotent: if the fragment
//! already has any successor, seed is a no-op (Y.Doc was loaded from prior
//! state).

use crate::crdt::md_to_yjs::{md_to_blocknote_blocks, BlockNoteBlock};
use crate::crdt::DocHandle;
use crate::error::AppResult;
use yrs::types::xml::XmlElementPrelim;
use yrs::types::xml::XmlTextPrelim;
use yrs::types::Attrs;
use yrs::{ReadTxn, Transact, XmlFragment};

pub fn seed_from_markdown(handle: &DocHandle, markdown: &str) -> AppResult<()> {
    let already_seeded = handle.with_read(|txn| {
        let frag = txn.get_or_insert_xml_fragment("prosemirror");
        frag.len(txn) > 0
    });
    if already_seeded {
        return Ok(());
    }

    let blocks = md_to_blocknote_blocks(markdown);
    handle.with_write(|txn| {
        let frag = txn.get_or_insert_xml_fragment("prosemirror");
        for block in &blocks {
            insert_block(&frag, txn, block);
        }
    });
    Ok(())
}

fn insert_block(
    frag: &yrs::XmlFragmentRef,
    txn: &mut yrs::TransactionMut<'_>,
    block: &BlockNoteBlock,
) {
    let tag = match block.kind.as_str() {
        "heading" => "heading",
        "codeBlock" => "codeBlock",
        "bulletListItem" => "bulletListItem",
        "numberedListItem" => "numberedListItem",
        _ => "paragraph",
    };
    let mut attrs = Attrs::new();
    if let Some(level) = block.level {
        attrs.insert("level".into(), level.to_string().into());
    }
    if let Some(lang) = &block.language {
        attrs.insert("language".into(), lang.clone().into());
    }
    let element = frag.push_back(txn, XmlElementPrelim::new(tag, attrs));
    if !block.text.is_empty() {
        element.push_back(txn, XmlTextPrelim::new(&block.text));
    }
}
```

(Method names match `yrs 0.21`; if API drift surfaces during implementation, adapt to the exact methods on `XmlFragmentRef`. The seed contract is: "produce a fragment such that BlockNote's `y-prosemirror` adapter renders the original blocks.")

- [ ] **Step 52.3: Wire into `crdt/mod.rs`**

```rust
pub mod md_to_yjs;
pub mod seed;
```

- [ ] **Step 52.4: Run + commit**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test crdt_seed_test
git commit -am "m5(crdt): seed_from_markdown idempotent first-open initialiser"
```

---

### Chunk 9 close-out

- [ ] `cargo test --test 'crdt_*'` shows ≥17 tests pass.
- [ ] Manually open a markdown-only note in `pnpm dev` — body content shows in BlockNote with paragraphs + headings + lists preserved.









