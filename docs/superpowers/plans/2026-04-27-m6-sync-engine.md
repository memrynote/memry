# M6 - Sync Engine Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the remaining mock sync/attachment surface with a real Rust sync engine that can push, pull, merge, retry, stream WebSocket notifications, sync CRDT updates, upload/download attachments, and drive the current Tauri renderer sync UI.

**Architecture:** M6 adds a Rust `sync` runtime inside `apps/desktop-tauri/src-tauri/src/sync/` and keeps Tauri commands thin: validate input -> call runtime/client/DB module -> emit typed event -> return DTO. The engine owns the pull -> apply -> push -> listen loop; local CRUD modules keep owning domain writes, while sync handlers translate encrypted remote payloads into existing DB/vault/CRDT operations. The renderer continues using the M1-M5 `invoke.ts` seam and graduates `sync_ops_*` plus attachment commands from mocks to real Tauri commands.

**Tech Stack:** Tauri 2.10, Rust 1.95, rusqlite, tokio, reqwest 0.12 with rustls, tokio-tungstenite, rustls, chacha20poly1305, dryoc/Ed25519 helpers from M4, yrs 0.21 from M5, httpmock, tempfile, Vitest, Playwright/Tauri runtime e2e, existing sync-server Hono/D1/R2 contracts.

**Parent spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` M6 section.

**Predecessor plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md` must be merged before M6 starts.

**Current repo baseline:** M4 auth/keychain/token storage exists; M5 notes/folders/properties/CRDT commands exist; `sync::http` is only a bare JSON client; `db/sync_queue.rs`, `db/sync_state.rs`, and `db/sync_history.rs` are DTO-only; `sync_ops_*` commands and `notes_*_attachment` still route through mocks/deferred ledger.

---

## Pre-flight Checks

- [ ] Confirm M5 is on the target base branch:

```bash
git log --oneline --decorate -12
```

Expected: latest branch contains the M5 notes/CRDT implementation and bindings.

- [ ] Confirm no unrelated local edits will be touched:

```bash
git status --short --branch
```

Expected: unrelated benchmark image diffs, if present, remain untouched by M6 plan work.

- [ ] Install dependencies if this is a fresh worktree:

```bash
pnpm install --frozen-lockfile
```

Expected: exits 0.

- [ ] Baseline the Tauri app before M6:

```bash
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
pnpm --filter @memry/desktop-tauri cargo:test
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri test:e2e -- --project=webkit
```

Expected: every command exits 0. If `test:e2e:runtime` skips on macOS because WKWebView has no desktop WebDriver backend, record the skip and run runtime e2e on CI/Linux/Windows later.

- [ ] Capture the current M5 command ledger:

```bash
pnpm --filter @memry/desktop-tauri command:parity > /tmp/m5-parity-baseline.txt
```

Expected: M6 deferred entries are visible for sync ops and attachments.

- [ ] Confirm sync-server contract tests are green:

```bash
pnpm --filter @memry/sync-server test -- src/routes/sync.test.ts src/routes/blob.test.ts src/services/crdt.test.ts
pnpm --filter @memry/contracts typecheck
```

Expected: exits 0. If the package name is different in this worktree, use the package name from `apps/sync-server/package.json`.

---

## M6 Decisions And Assumptions

- **Transport shape:** Rust mirrors existing sync-server routes: `/sync/records/status`, `/sync/records/changes`, `/sync/records/push`, `/sync/records/pull`, `/sync/ws`, `/sync/crdt/updates`, `/sync/crdt/updates/batch`, `/sync/crdt/snapshot`, `/blob/*`, and `/attachments/*`. Keep legacy `/sync/status` aliases only if sync-server tests prove they are still required.
- **Token source:** Access and refresh tokens stay in the M4 keychain entries under `SERVICE_VAULT`. M6 adds a shared token helper that reads access tokens, refreshes once on 401, stores the replacement pair, and emits `auth-session-expired` when refresh fails.
- **DB access rule:** No `rusqlite::Connection` guard crosses `.await`. Every async command/engine path snapshots DB work into owned values, drops the connection, awaits network/file work, then reacquires DB for persistence.
- **Queue durability:** `sync_queue` remains the durable local mutation queue. Add CRUD and coalescing code; avoid a new queue table unless a schema diff proves the existing table cannot support M6.
- **Local mutation wiring:** The engine is useless unless live local writes enqueue records. Wire current M5 real note/folder/tag/folder-config paths in M6; expose helpers for M8-only domains without touching mock-only CRUD.
- **Event names:** Tauri runtime events remain kebab-case without Electron colons because the current renderer listens to names like `sync-status-changed`, `item-synced`, `upload-progress`, and `certificate-pin-failed`. Keep a mapping table from Electron contract events to Tauri event names in tests.
- **Handler count:** Implement all current `RECORD_SYNC_ITEM_TYPES`: note, task, project, settings, inbox, filter, journal, tag_definition, folder_config, calendar_event, calendar_source, calendar_binding, calendar_external_event. Attachments use the blob route and note metadata, not the record handler trait.
- **Google Calendar provider sync:** M6 only syncs local calendar records through the generic record engine. Google OAuth/provider polling, deep-link OAuth callback routing, and webhook lifecycle remain M8/M9 shell/provider work unless already shipped by another branch.
- **CRDT ordering:** On first start/full sync: pull records -> apply records -> seed existing CRDT docs asynchronously -> push local CRDT snapshots/updates per note -> push record queue. Do not push snapshots before the device is registered and unlocked.
- **CRDT wire:** Use base64 JSON over sync-server CRDT routes. Keep M5 local Tauri CRDT IPC binary discipline unchanged; network payloads are separate.
- **Attachments:** M6 implements real upload/download/list/delete for current note editor calls and sync attachment calls. Attachment transfer progress is process-local; server-side chunk dedupe makes retry safe. Durable resumable transfer UI can be M8 if needed.
- **Certificate pinning:** Do the pinning spike before the rest of HTTP work. If reqwest/rustls does not expose the needed verifier cleanly with current features, stop and document the smallest dependency feature change before continuing.
- **Spec-text divergence (handlers):** The design spec text in section M6 lists `bookmarks`, `templates`, and `reminders` as handlers. None are in `RECORD_SYNC_ITEM_TYPES` (`packages/contracts/src/sync-api.ts`) and none have an Electron handler under `apps/desktop/src/main/sync/item-handlers/`. The contract is the source of truth. M6 implements the 13 handlers listed in `RECORD_SYNC_ITEM_TYPES`; correcting the spec text is tracked separately, not in this plan.
- **Event burst batching:** Electron's `microtask-batch-broadcaster.ts` debounces high-volume CRDT/sync events before forwarding them to the renderer. Tokio's scheduler differs from Node's microtask queue, so a direct port is unnecessary. M6 ships without a coalescer and observes engine→renderer event volume during the 24-hour WS stress (Chunk 13). If a single-note 100-update burst causes renderer jank or dropped frames, add a short tokio-side debouncer before the Tauri `app.emit` call; otherwise defer to a follow-up.
- **Non-goals:** Do not implement M7 search/index DB, M8 export/version/import/native shell, M9 updater/deep-link registration, or broad Electron cleanup.

---

## File Structure

Files M6 creates or modifies:

```text
apps/desktop-tauri/
|-- package.json                                      verify existing scripts only
|-- src/
|   |-- lib/ipc/invoke.ts                             graduate M6 commands from mock to real
|   |-- lib/ipc/mocks/sync.ts                         remove/retire M6 mock routes when real
|   |-- lib/ipc/mocks/stubs/attachments.ts            delete or leave unused after graduation
|   |-- contexts/sync-context.tsx                     event-name and status DTO alignment only
|   |-- hooks/use-sync-history.ts                     shape alignment if Rust DTO differs
|   |-- hooks/use-storage-usage.ts                    shape alignment if Rust DTO differs
|   `-- services/notes-service.ts                     attachment wrapper shape alignment
|-- src-tauri/
|   |-- Cargo.toml                                    add tokio-tungstenite/rustls deps + tests
|   |-- capabilities/default.json                     allow sync/attachment commands
|   |-- build.rs                                      command manifest if required by checker
|   |-- src/lib.rs                                    register sync runtime + commands
|   |-- src/app_state.rs                              add SyncRuntime field
|   |-- src/error.rs                                  add sync/network/cert categories
|   |-- src/commands/mod.rs                           add sync_ops + attachments modules
|   |-- src/commands/sync_ops.rs                      new: sync status/control/history/settings
|   |-- src/commands/attachments.rs                   new: notes + sync attachment commands
|   |-- src/sync/mod.rs                               exports
|   |-- src/sync/runtime.rs                           new: SyncRuntime Arc, task handles, state
|   |-- src/sync/engine.rs                            new: start/stop/full/push/pull loop
|   |-- src/sync/client.rs                            new: typed sync-server route wrapper
|   |-- src/sync/http.rs                              expand existing bare JSON client
|   |-- src/sync/pinning.rs                           new: certificate pin verifier
|   |-- src/sync/ws.rs                                new: WebSocket manager
|   |-- src/sync/retry.rs                             new: retry/backoff helpers
|   |-- src/sync/queue.rs                             new: durable queue manager over DB
|   |-- src/sync/history.rs                           new: sync_history writer/reader
|   |-- src/sync/status.rs                            new: status DTO/event helpers
|   |-- src/sync/session.rs                           new: token read/refresh/session expiry
|   |-- src/sync/network.rs                           new: online/offline state + retry hooks
|   |-- src/sync/quarantine.rs                        new: signature/corruption quarantine
|   |-- src/sync/local_mutations.rs                    new: enqueue helpers for local CRUD paths
|   |-- src/sync/clock_skew.rs                        new: server/local time skew warnings
|   |-- src/sync/device_keys.rs                       new: current/remote device key lookup
|   |-- src/sync/crypto_batch.rs                      new: encrypt/decrypt/sign/verify batches
|   |-- src/sync/vector_clock.rs                      new: compare/merge/increment helpers
|   |-- src/sync/field_merge.rs                       new: per-field merge helpers
|   |-- src/sync/crdt_updates.rs                      new: network CRDT sync coordinator
|   |-- src/sync/attachments.rs                       new: encrypted chunk upload/download
|   |-- src/sync/upload_queue.rs                      new: bounded concurrent upload queue
|   `-- src/sync/handlers/
|       |-- mod.rs                                    new: registry
|       |-- types.rs                                  new: SyncItemHandler trait
|       |-- note.rs                                   new
|       |-- task.rs                                   new
|       |-- project.rs                                new
|       |-- settings.rs                               new
|       |-- inbox.rs                                  new
|       |-- filter.rs                                 new
|       |-- journal.rs                                new
|       |-- tag_definition.rs                         new
|       |-- folder_config.rs                          new
|       |-- calendar_event.rs                         new
|       |-- calendar_source.rs                        new
|       |-- calendar_binding.rs                       new
|       `-- calendar_external_event.rs                new
|-- e2e/runtime/specs/
|   |-- sync-two-device.spec.ts                       new runtime/CI scenario
|   |-- sync-offline-restart.spec.ts                  new runtime/CI scenario
|   `-- sync-attachments.spec.ts                      new runtime/CI scenario
`-- scripts/command-parity-audit.ts                   M6 required-real ledger

apps/sync-server/
|-- src/contracts/sync-records.ts                     rehome sync contract if package extraction is needed
|-- src/contracts/blob.ts                             rehome blob contract if package extraction is needed
`-- src/routes/sync.test.ts                           add Rust parity fixtures if missing

packages/contracts/
`-- src/*.test.ts                                     extend only when schema gaps are proven
```

Rust tests to add to `Cargo.toml`:

```toml
[[test]]
name = "sync_pinning_test"
required-features = ["test-helpers"]

[[test]]
name = "sync_http_contract_test"
required-features = ["test-helpers"]

[[test]]
name = "sync_queue_test"
required-features = ["test-helpers"]

[[test]]
name = "sync_retry_test"
required-features = ["test-helpers"]

[[test]]
name = "sync_vector_clock_test"
required-features = ["test-helpers"]

[[test]]
name = "sync_field_merge_test"
required-features = ["test-helpers"]

[[test]]
name = "sync_crypto_batch_test"
required-features = ["test-helpers"]

[[test]]
name = "sync_handlers_test"
required-features = ["test-helpers"]

[[test]]
name = "sync_local_mutations_test"
required-features = ["test-helpers"]

[[test]]
name = "sync_engine_test"
required-features = ["test-helpers"]

[[test]]
name = "sync_ws_test"
required-features = ["test-helpers"]

[[test]]
name = "sync_crdt_updates_test"
required-features = ["test-helpers"]

[[test]]
name = "sync_attachments_test"
required-features = ["test-helpers"]

[[test]]
name = "commands_sync_ops_test"
required-features = ["test-helpers"]
```

---

## Command And Event Parity Target

M6 graduates these commands to real Rust and generated bindings:

```text
sync_ops_get_status
sync_ops_trigger_sync
sync_ops_get_history
sync_ops_get_queue_size
sync_ops_pause
sync_ops_resume
sync_ops_update_synced_setting
sync_ops_get_synced_settings
sync_ops_get_storage_breakdown
sync_ops_get_quarantined_items
sync_ops_retry_quarantined_item
sync_ops_delete_quarantined_item
sync_ops_check_device_status
sync_ops_emergency_wipe
sync_start
sync_stop
sync_push_now
sync_pull_now
sync_status
sync_reset_cursor
notes_upload_attachment
notes_list_attachments
notes_delete_attachment
sync_attachments_upload_attachment
sync_attachments_get_upload_progress
sync_attachments_download_attachment
sync_attachments_get_download_progress
```

M6 emits and tests these event names:

```text
sync-status-changed
sync-progress
sync-error
sync-completed
item-synced
conflict-detected
sync-paused
sync-resumed
queue-cleared
initial-sync-progress
upload-progress
download-progress
attachment-upload-failed
auth-session-expired
device-revoked
clock-skew-warning
security-warning
certificate-pin-failed
crdt-sync-step
```

Do not remove M4 auth/device/linking commands from real routing. M6 builds on them.

---

## Mock Retirement Mapping

`apps/desktop-tauri/src/lib/ipc/mocks/sync.ts` carries M1 mock routes that predate the M6 command surface. Each legacy mock name lands in exactly one of three buckets during M6 execution. A legacy mock route may not survive past Chunk 12 with no decision recorded.

| Legacy mock name | Outcome | Replacement / notes |
|---|---|---|
| `sync_status` | Keep name | Same name graduates to a real Tauri command (top-level engine status). Chunk 12 step 5. |
| `sync_trigger` | Retire mock | Renderer call sites move to `sync_ops_trigger_sync` (full sync) or `sync_push_now` (push-only devtools). |
| `sync_stats` | Retire mock | Renderer call sites move to `sync_ops_get_history` (latest entry returns `pushed/pulled/failed/durationMs`). If no caller remains, delete the route outright. |
| `sync_identity` | Retire mock | Renderer call sites move to `account_get_info` (M4 real) or a new `sync_get_identity` if a distinct shape is required. Decide during Chunk 12. |
| `sync_enable` | Retire mock | Replaced by `sync_ops_pause` / `sync_ops_resume`. Renderer "enabled" flag reads `sync_ops_get_status` `paused` field. |
| `sync_pending_items` | Retire mock | Replaced by `sync_ops_get_queue_size` (count) and `sync_ops_get_quarantined_items` (list). |
| `sync_reset` | Retire mock | Replaced by `sync_reset_cursor` (devtools/debug only). |
| `sync_ops_get_status` | Keep name | Already kept as the shape canonical for the new command. |

Discipline:

- Chunk 12 step 5 must visit each entry above and either rewrite the renderer call site, route the legacy name through the new command via a thin alias in `invoke.ts`, or delete the route. The mock file may not contain a route name that no longer maps to a real command after Chunk 12 closes.
- `command-parity-audit.ts` must fail when an unmapped legacy name still exists in `sync.ts`.
- The PR body ledger (Chunk 15 step 5) lists the disposition of every row above.

---

## Chunk 1: Contract Extraction And Ledger Lock

**Files:**
- Modify: `packages/contracts/src/sync-api.ts` only if schema gaps are proven
- Modify: `packages/contracts/src/blob-api.ts` only if schema gaps are proven
- Create/Modify: `apps/sync-server/src/contracts/*` if package extraction is needed
- Modify: `apps/sync-server/src/routes/sync.test.ts`
- Modify: `apps/sync-server/src/routes/blob.test.ts`
- Modify: `apps/desktop-tauri/scripts/command-parity-audit.ts`
- Modify: `apps/desktop-tauri/src/lib/ipc/invoke.ts`
- Modify: `apps/desktop-tauri/src/lib/ipc/mocks/sync.ts`
- Test: `apps/desktop-tauri/src/lib/ipc/mocks/sync.test.ts`

- [ ] Step 1: Freeze the sync-server contract source of truth.

Inspect:
- `packages/contracts/src/sync-api.ts`
- `packages/contracts/src/blob-api.ts`
- `apps/sync-server/src/routes/sync.ts`
- `apps/sync-server/src/routes/blob.ts`
- `apps/sync-server/src/services/crdt.ts`

If sync-server still imports the package contracts cleanly, do not move files. If Rust-client work would make the package dependency awkward, rehome only the sync/auth/blob contract modules touched by M6 under `apps/sync-server/src/contracts/` and leave package exports as compatibility wrappers until M10.

Confirm route canonicalization. `apps/sync-server/src/routes/sync.ts` currently mounts both `/sync/{status,manifest,changes,push,pull,items}` (legacy) and `/sync/records/{status,manifest,changes,push,pull,items}` (record-prefixed) and both call the same handlers. The Rust client targets the `/sync/records/*` family per the Decisions section. Before any HTTP work in Chunk 2:

- Verify both route families still resolve in `routes/sync.test.ts`.
- Decide explicitly whether the legacy aliases stay live through M10. Default: keep them live; deprecation lives in M10 cleanup. Record the decision in the PR body for this chunk.
- Do not remove either family from sync-server in M6.

- [ ] Step 2: Add protocol parity fixtures.

Create canonical JSON fixtures for:
- record changes response
- record pull response
- record push request/response
- CRDT update push/pull/batch/snapshot
- blob upload init/chunk/complete/status
- storage breakdown

Expected: sync-server tests and Rust tests consume the same fixture files.

- [ ] Step 3: Run sync-server and contract checks.

```bash
pnpm --filter @memry/sync-server test -- src/routes/sync.test.ts src/routes/blob.test.ts src/services/crdt.test.ts
pnpm --filter @memry/contracts typecheck
```

Expected: PASS before Rust client work starts.

- [ ] Step 4: Add failing M6 ledger assertions.

Add M6 commands to `REQUIRED_REAL` in `command-parity-audit.ts`, but do not implement handlers yet.

- [ ] Step 5: Run the audit and confirm failure.

```bash
pnpm --filter @memry/desktop-tauri command:parity
```

Expected: FAIL with missing generated handler/binding errors for M6 sync and attachment commands.

- [ ] Step 6: Add `realCommands` entries only after the Rust handlers land in later chunks.

Do not route the renderer to non-existent commands in this chunk.

- [ ] Step 7: Keep deferred entries with a TODO marker until each command graduates.

Expected: no renderer-only commands appear; everything is real, mocked, or deferred.

- [ ] Step 8: Stage parity-ledger changes; do not commit until the first Rust sync command lands.

The audit at step 5 fails until handlers exist. Committing ledger-only would leave the repo in a known-failing state for the duration of Chunk 2/3. Stage the ledger work now and bundle it into the first M6 PR that graduates a real command.

Stage only:

```bash
git add packages/contracts apps/sync-server apps/desktop-tauri/scripts/command-parity-audit.ts apps/desktop-tauri/src/lib/ipc/invoke.ts
# DO NOT commit yet — wait until Chunk 2/3 ships sync_status (or whichever command graduates first).
```

Once the first command graduates and `pnpm --filter @memry/desktop-tauri command:parity` exits 0 for that command, commit the bundle:

```bash
git commit -m "m6(sync): lock sync command parity ledger and graduate first command"
```

If you need to context-switch off the branch before the first command lands, `git stash --keep-index --include-untracked` the staged files and leave a note in the WIP plan section of the PR body.

---

## Chunk 2: HTTP Client, Token Session, And Cert Pinning

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml`
- Modify: `apps/desktop-tauri/src-tauri/src/sync/http.rs`
- Create: `apps/desktop-tauri/src-tauri/src/sync/client.rs`
- Create: `apps/desktop-tauri/src-tauri/src/sync/session.rs`
- Create: `apps/desktop-tauri/src-tauri/src/sync/pinning.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/sync/mod.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/sync_http_contract_test.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/sync_pinning_test.rs`

- [ ] Step 1: Write HTTP contract tests against `httpmock`.

Tests:
- GET `/sync/records/status` includes bearer token and parses status.
- 401 refreshes once through `/auth/refresh`, stores the new token pair, and retries.
- N concurrent in-flight 401s during a burst push trigger exactly one `/auth/refresh` round-trip; remaining requests await the in-flight refresh and reuse the new access token. Verify with httpmock hit counts.
- Refresh failure clears tokens and emits `auth-session-expired`; subsequent requests fail fast without re-attempting refresh until the user re-authenticates.
- 429 returns `RateLimited(retry_after)`.
- non-2xx never logs response body bytes.
- `SYNC_SERVER_URL` remains per-call configurable for tests.

Run:

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_http_contract_test
```

Expected: FAIL because typed client/session helper does not exist.

- [ ] Step 2: Write cert pinning tests.

Tests:
- matching SPKI hash accepts the connection.
- mismatched hash returns a sync error category `certificate_pin_failed`.
- pin failure emits no retryable network state.

Run:

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_pinning_test
```

Expected: FAIL until `pinning.rs` exists.

- [ ] Step 3: Implement `SyncSession`.

Responsibilities:
- `access_token() -> AppResult<String>` — returns the cached access token; awaits an in-flight refresh if one is running.
- `refresh_once() -> AppResult<String>` — coalesces concurrent calls behind a `tokio::sync::Mutex<RefreshState>` (or equivalent `OnceCell` + broadcast channel). The first caller performs the `/auth/refresh` round-trip; concurrent callers await the same future and share its result.
- `clear_tokens_on_session_expired()` — clears keychain entries, emits `auth-session-expired`, and flips `RefreshState` to a sticky failure mode that fails subsequent `refresh_once` calls fast until the user re-authenticates.
- reads/writes `KEYCHAIN_ACCESS_TOKEN` and `KEYCHAIN_REFRESH_TOKEN`.
- redacts all token bytes from errors through existing redaction helpers.

The in-flight guard prevents N parallel push workers from each launching their own refresh during a burst (the case Electron's `token-manager.ts` solved with a refresh mutex). It does not implement pre-emptive expiry refresh; that lands in a follow-up if observability shows wasted 401 round-trips.

- [ ] Step 4: Implement `SyncHttpClient`.

Methods:
- `get_json<T>(path)`
- `post_json<TReq, TResp>(path, body)`
- `put_bytes(path, bytes)`
- `get_bytes(path, range?)`
- `delete(path)`

Keep `*_with_base` variants for tests.

- [ ] Step 5: Implement pinning spike result.

If the custom rustls verifier requires a feature/dependency change, make the smallest Cargo change and record it in this plan's PR body.

- [ ] Step 6: Run tests.

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_http_contract_test --test sync_pinning_test
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

Expected: PASS.

---

## Chunk 3: Queue, Retry, State, And History

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/db/sync_queue.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/db/sync_state.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/db/sync_history.rs`
- Create: `apps/desktop-tauri/src-tauri/src/sync/queue.rs`
- Create: `apps/desktop-tauri/src-tauri/src/sync/retry.rs`
- Create: `apps/desktop-tauri/src-tauri/src/sync/history.rs`
- Create: `apps/desktop-tauri/src-tauri/src/sync/status.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/sync_queue_test.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/sync_retry_test.rs`

- [ ] Step 1: Write queue tests.

Tests:
- enqueue create/update/delete writes durable rows.
- same item/type coalesces create/update/delete like Electron.
- dequeue orders by priority desc then created_at asc.
- mark_success deletes row.
- mark_failed increments attempts and preserves redacted error.
- pending/failed/dead-letter counts match Electron semantics.

Run:

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_queue_test
```

Expected: FAIL until CRUD exists.

- [ ] Step 2: Write retry tests.

Tests:
- exponential backoff caps at max.
- 429 honors retry-after.
- 4xx except 429 is non-retryable.
- abort signal stops sleep.
- offline wait resumes when network status flips.

Run:

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_retry_test
```

Expected: FAIL.

- [ ] Step 3: Implement `SyncQueueManager`.

Keep API small:

```rust
pub struct EnqueueInput {
    pub item_type: SyncItemType,
    pub item_id: String,
    pub operation: SyncOperation,
    pub payload: String,
    pub priority: i64,
}
```

Expose `enqueue`, `dequeue`, `mark_success`, `mark_failed`, `stats`, `clear`, and `remove_by_item_id`.

- [ ] Step 4: Implement retry helpers.

Use tokio sleep and owned abort state. Do not hold DB locks while sleeping.

- [ ] Step 5: Implement state/history helpers.

State keys:
- `last_cursor`
- `last_sync_at`
- `sync_paused`
- `offline_since`
- `crdt_cursor:<note_id>`

History types:
- `push`
- `pull`
- `error`

- [ ] Step 6: Run focused gate.

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_queue_test --test sync_retry_test
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

Expected: PASS.

---

## Chunk 4: Vector Clocks And Field Merge

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/sync/vector_clock.rs`
- Create: `apps/desktop-tauri/src-tauri/src/sync/field_merge.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/sync_vector_clock_test.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/sync_field_merge_test.rs`

- [ ] Step 1: Write vector-clock tests.

Cases:
- before/after/equal/concurrent.
- merge takes max tick per device.
- `_offline` pseudo-device is accepted and rebound before push.
- invalid JSON returns validation error, not panic.

- [ ] Step 2: Write field merge tests.

Cases:
- task title local and due date remote both survive.
- concurrent same-field conflict reports `had_conflicts`.
- project field clocks use project syncable field list.
- calendar field clocks preserve rich fields.

Run:

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_vector_clock_test --test sync_field_merge_test
```

Expected: FAIL.

- [ ] Step 3: Implement vector-clock helpers.

Keep JSON representation as `serde_json::Map<String, Value>` at DB boundary and typed `BTreeMap<String, u64>` inside sync code for deterministic output.

- [ ] Step 4: Implement `merge_fields`.

Port the Electron behavior from `apps/desktop/src/main/sync/field-merge.ts`:
- remote wins when remote total is greater.
- local wins when local total is greater.
- equal totals prefer remote except offline-local changed value.
- concurrent differing values report conflict and merged clock.

- [ ] Step 5: Run focused gate.

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_vector_clock_test --test sync_field_merge_test
```

Expected: PASS.

---

## Chunk 5: Crypto Batch And Device Key Resolution

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/sync/crypto_batch.rs`
- Create: `apps/desktop-tauri/src-tauri/src/sync/device_keys.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/crypto/mod.rs` only if existing helpers need public exports
- Test: `apps/desktop-tauri/src-tauri/tests/sync_crypto_batch_test.rs`

- [ ] Step 1: Write crypto batch tests.

Cases:
- encrypt push item produces encrypted key/data/nonces/signature/signerDeviceId.
- decrypt verifies signature with signer device public key.
- unknown signer device quarantines item without applying it.
- signature failure emits security warning path.
- key bytes are zeroized after use.

Run:

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_crypto_batch_test
```

Expected: FAIL until module exists.

- [ ] Step 2: Implement current device key lookup.

Read current device row from `sync_devices`, signing key from keychain, and vault key from `AuthRuntime`. Return owned zeroizing bytes where possible.

- [ ] Step 3: Implement remote device public-key cache.

Source:
- local `sync_devices.signing_public_key`
- fallback `GET /devices` through M4 device client if missing.

- [ ] Step 4: Implement batch encrypt/decrypt.

Use existing M4 primitives. Do not introduce a worker thread unless profiling proves encryption blocks runtime tests.

- [ ] Step 5: Run focused gate.

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_crypto_batch_test
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

Expected: PASS.

---

## Chunk 6: Sync Handler Registry

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/sync/handlers/mod.rs`
- Create: `apps/desktop-tauri/src-tauri/src/sync/handlers/types.rs`
- Create: all handler files listed in File Structure
- Modify: existing `apps/desktop-tauri/src-tauri/src/db/*.rs` modules only to add focused fetch/upsert helpers required by handlers
- Test: `apps/desktop-tauri/src-tauri/tests/sync_handlers_test.rs`

- [ ] Step 1: Write registry coverage test.

Assert every `RECORD_SYNC_ITEM_TYPES` value has one handler and no extras.

- [ ] Step 2: Define `SyncItemHandler`.

Minimal trait:

```rust
pub trait SyncItemHandler {
    fn item_type(&self) -> SyncItemType;
    fn fetch_local(&self, conn: &Connection, item_id: &str) -> AppResult<Option<serde_json::Value>>;
    fn build_push_payload(
        &self,
        conn: &Connection,
        item_id: &str,
        device_id: &str,
        operation: SyncOperation,
    ) -> AppResult<Option<serde_json::Value>>;
    fn apply_remote(
        &self,
        conn: &Connection,
        item_id: &str,
        operation: SyncOperation,
        payload: serde_json::Value,
        clock: Option<VectorClock>,
    ) -> AppResult<ApplyResult>;
}
```

- [ ] Step 3: Implement note/task/project/settings first.

Tests:
- note upsert updates metadata and leaves CRDT body to CRDT coordinator.
- task different-field conflict merges both fields.
- project archive clock respects remote deletion.
- settings field update uses settings sync schema.

- [ ] Step 4: Implement inbox/filter/journal/tag/folder handlers.

Tests:
- tombstones skip active rows correctly.
- folder config template JSON survives round-trip.
- journal date ID behavior matches M5 note metadata.

- [ ] Step 5: Implement calendar record handlers.

Tests:
- calendar event/source/binding/external-event payloads include clocks.
- provider tokens/secrets are not serialized into record sync payloads.

- [ ] Step 6: Run focused gate.

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_handlers_test
```

Expected: PASS, with at least one positive and one delete/tombstone test per handler.

---

## Chunk 7: Local Mutation Enqueue Wiring

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/sync/local_mutations.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/commands/notes.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/commands/folders.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/commands/properties.rs` only for syncable metadata changes
- Modify: future-facing DB helpers under `apps/desktop-tauri/src-tauri/src/db/*.rs` only where a local write already exists
- Test: `apps/desktop-tauri/src-tauri/tests/sync_local_mutations_test.rs`

- [ ] Step 1: Write local mutation tests.

Cases:
- `notes_create` enqueues a `note/create` record after the DB/vault write commits.
- `notes_update` enqueues `note/update` and increments/rebinds clock metadata.
- `notes_delete` enqueues `note/delete` tombstone and does not enqueue if local-only.
- folder config edits enqueue `folder_config/update`.
- tag definition edits enqueue `tag_definition/update` when those commands are live.
- failed vault/DB writes do not enqueue.
- duplicate update bursts coalesce in `sync_queue`.
- Offline-only edit (no current device id available — keychain device row missing or unread) records ticks under the `_offline` pseudo-device key (`OFFLINE_CLOCK_DEVICE_ID` from contracts).
- After the device row becomes available (post-registration / post-unlock), the next push batch rebinds `_offline` ticks onto the current `device_id` before `crypto_batch::sign_and_encrypt` runs. Push payload contains `clock[<device_id>]`, never `clock["_offline"]`.
- Rebind is idempotent: if a queue row was already rebound and the engine restarts, the second push does not double-bump the device tick.

Run:

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_local_mutations_test
```

Expected: FAIL until local mutation helpers exist.

- [ ] Step 2: Add Cargo test entry.

```toml
[[test]]
name = "sync_local_mutations_test"
required-features = ["test-helpers"]
```

- [ ] Step 3: Implement `local_mutations.rs`.

Expose small helpers:
- `enqueue_create(state, item_type, item_id)`
- `enqueue_update(state, item_type, item_id, changed_fields)`
- `enqueue_delete(state, item_type, item_id)`
- `bump_clock_json(existing, device_id_or_offline)` — writes ticks under `_offline` when no device id is available.
- `bump_field_clocks_json(existing, changed_fields, device_id_or_offline)` — same offline behavior per-field.
- `rebind_offline_clocks(payload, device_id)` — called by the push coordinator (Chunk 8 step 3) before encrypt/sign. Replaces `_offline` keys with `device_id` and merges ticks deterministically. Idempotent on rows already rebound.

- [ ] Step 4: Wire only currently real local write paths.

M6 must wire M5 real notes/folders/tag/folder-config paths. For M8-only task/project/inbox/calendar commands, expose helpers and handler tests now, but do not patch mock-only renderer paths.

- [ ] Step 5: Add stop guard for local-only notes.

`sync_policy = local_only` or `local_only = true` must not enqueue network sync records.

- [ ] Step 6: Run focused gate.

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_local_mutations_test --test sync_queue_test
```

Expected: PASS.

---

## Chunk 8: Push/Pull Coordinators And Engine Runtime

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/sync/engine.rs`
- Create: `apps/desktop-tauri/src-tauri/src/sync/runtime.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/app_state.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/sync_engine_test.rs`

- [ ] Step 1: Write engine lifecycle tests.

Cases:
- `start` with no auth stays idle.
- `start` with auth pulls before push.
- `push_now` drains queue in batches of 100.
- `pull_now` applies changes and advances cursor exactly once.
- `stop` aborts WS/listen loop and does a bounded final push.
- pause prevents scheduled sync but preserves queue.

Run:

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_engine_test
```

Expected: FAIL.

- [ ] Step 2: Implement `SyncRuntime`.

Fields:
- `engine: tokio::sync::Mutex<Option<SyncEngine>>`
- `status: watch::Sender<SyncStatusView>`
- `task_handles`
- `quarantine`

- [ ] Step 3: Implement push coordinator.

Flow:
1. Read queue batch from DB.
2. Build payloads through handlers.
3. Encrypt/sign batch.
4. POST `/sync/records/push`.
5. Mark accepted rows success.
6. Mark rejected rows failed.
7. Emit `item-synced` and status events.

- [ ] Step 4: Implement pull coordinator.

Flow:
1. GET `/sync/records/changes?cursor=<last_cursor>&limit=<page>`.
2. POST `/sync/records/pull` for item refs.
3. Decrypt/verify pulled items.
4. Apply through handlers.
5. Persist cursor after successful page.
6. Compare serverTime to local time and emit `clock-skew-warning` when outside tolerance.
7. Emit conflict/security/status/history events.

- [ ] Step 5: Implement full sync.

Order: pull records -> seed existing CRDT docs -> push CRDT -> push records -> connect/listen.

- [ ] Step 6: Run focused gate.

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_engine_test
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

Expected: PASS.

---

## Chunk 9: WebSocket Listener

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/sync/ws.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/sync/engine.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/sync_ws_test.rs`

- [ ] Step 1: Write WS tests.

Cases:
- connects to `/sync/ws` with bearer token and `X-App-Version` header.
- `changes_available` schedules pull.
- `crdt_updated` schedules CRDT pull for note.
- heartbeat timeout reconnects.
- reconnect backoff caps under 5 seconds for first retry in acceptance mode.
- cert pin failure emits `certificate-pin-failed` and stops reconnect.

Close-code dispatch (server-defined in `apps/sync-server/src/durable-objects/user-sync-state.ts`):

- code 4001 (replaced by another connection from same device) → log, do not reconnect immediately, wait for next sync trigger.
- code 4003 (token expired) → emit `auth-session-expired`, drive `SyncSession::clear_tokens_on_session_expired()`, stop reconnect until re-authenticated.
- code 4004 (device revoked) → emit `device-revoked`, stop reconnect permanently for this session, surface to settings UI.
- code 4008 (rate limited) → honor `Retry-After` if present, otherwise back off via standard retry policy; do not emit `auth-session-expired`.
- code 4009 (version incompatible) → emit `security-warning` with the server-provided `minVersion`, stop reconnect until app updates.
- any other abnormal close → standard backoff + reconnect, count failures into `sync-error` event.

- [ ] Step 2: Add test entry to `Cargo.toml`.

- [ ] Step 3: Implement `WebSocketManager`.

Use `tokio-tungstenite`; parse messages conservatively with typed enum. Map server close codes to a `WsCloseReason` enum (`Replaced`, `TokenExpired`, `DeviceRevoked`, `RateLimited(Option<u64>)`, `VersionIncompatible(String)`, `Other(u16)`). The reconnect loop reads the close reason and decides whether to backoff, sleep, or stop reconnect entirely per the table in step 1.

- [ ] Step 4: Integrate with engine.

The engine owns whether WS should be connected. `stop` must close it and cancel reconnect sleeps.

- [ ] Step 5: Run focused gate.

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_ws_test
```

Expected: PASS.

---

## Chunk 10: CRDT Network Sync

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/sync/crdt_updates.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/crdt/*` only for narrow exported helpers
- Modify: `apps/desktop-tauri/src-tauri/src/db/crdt_updates.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/db/crdt_snapshots.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/sync_crdt_updates_test.rs`

- [ ] Step 1: Write CRDT sync tests.

Cases:
- local pending updates POST to `/sync/crdt/updates` as base64 and persist returned sequence.
- remote update pull applies to M5 `CrdtRuntime`.
- batch pull handles 100 notes with independent cursors.
- snapshot push uploads current encoded doc and does not prune unconfirmed local updates.
- sign-out/sign-in preserves local CRDT rows and resumes cursor.
- network payload over 5MB is rejected before send.

Run:

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_crdt_updates_test
```

Expected: FAIL.

- [ ] Step 2: Implement CRDT cursor state.

Use `sync_state` keys `crdt_cursor:<note_id>` and persist only after all updates for that note apply.

- [ ] Step 3: Implement push.

Read M5 `crdt_updates` rows without `synced_at`/server sequence metadata. If existing schema lacks this metadata, add the smallest migration and DB helpers before pushing.

- [ ] Step 4: Implement pull.

Apply updates via existing M5 `crdt_apply_update` inner helper or a new internal function. Do not re-emit local-origin updates back to renderer as duplicates.

- [ ] Step 5: Implement seed existing CRDT.

Fire-and-forget after initial pull; errors become sync history error rows and `crdt-sync-step` events, not engine crash.

- [ ] Step 6: Run focused gate.

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_crdt_updates_test
```

Expected: PASS.

---

## Chunk 11: Attachments And Blob Sync

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/sync/attachments.rs`
- Create: `apps/desktop-tauri/src-tauri/src/sync/upload_queue.rs`
- Create: `apps/desktop-tauri/src-tauri/src/commands/attachments.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/commands/mod.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/db/note_metadata.rs`
- Modify: `apps/desktop-tauri/src/lib/ipc/invoke.ts`
- Test: `apps/desktop-tauri/src-tauri/tests/sync_attachments_test.rs`

- [ ] Step 1: Write attachment tests.

Cases:
- `notes_upload_attachment` validates note id and file path.
- empty file fails.
- >500MB fails before upload.
- chunks are 8MB max.
- upload initiate -> chunk PUT -> complete writes note metadata `attachment_id` and `attachment_references`.
- chunk 409 duplicate is treated as resumable success.
- download target must stay under vault attachments folder.
- progress events include attachmentId/sessionId/progress/status.
- delete removes local metadata and calls server manifest/blob cleanup when authenticated.

Run:

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_attachments_test
```

Expected: FAIL.

- [ ] Step 2: Implement upload service.

Use `/attachments/upload/initiate`, `/attachments/upload/:session_id/chunk/:chunk_index`, `/attachments/upload/:session_id/complete`, `/attachments/upload/:session_id`, and chunk HEAD/GET routes.

- [ ] Step 3: Implement manifest encryption/signing.

Mirror Electron attachment manifest shape. Keep file key wrapped by vault key; never persist plaintext file key.

- [ ] Step 4: Implement commands.

Commands:
- `notes_upload_attachment`
- `notes_list_attachments`
- `notes_delete_attachment`
- `sync_attachments_upload_attachment`
- `sync_attachments_get_upload_progress`
- `sync_attachments_download_attachment`
- `sync_attachments_get_download_progress`

- [ ] Step 5: Graduate renderer routing.

Remove `notes_upload_attachment`, `notes_list_attachments`, and `notes_delete_attachment` from `DEFERRED_COMMANDS`; add them to `realCommands`.

- [ ] Step 6: Run focused gate.

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_attachments_test
pnpm --filter @memry/desktop-tauri bindings:generate
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri command:parity
```

Expected: PASS.

---

## Chunk 12: Sync Ops Commands And Renderer Wiring

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/commands/sync_ops.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`
- Modify: `apps/desktop-tauri/src-tauri/capabilities/default.json`
- Modify: `apps/desktop-tauri/src/lib/ipc/invoke.ts`
- Modify: `apps/desktop-tauri/src/contexts/sync-context.tsx`
- Modify: `apps/desktop-tauri/src/hooks/use-sync-history.ts`
- Modify: `apps/desktop-tauri/src/hooks/use-storage-usage.ts`
- Test: `apps/desktop-tauri/src-tauri/tests/commands_sync_ops_test.rs`
- Test: `apps/desktop-tauri/src/contexts/sync-context.test.tsx`

- [ ] Step 1: Write command tests.

Cases:
- `sync_ops_get_status` returns idle when no auth.
- `sync_ops_trigger_sync` calls `full_sync`.
- `sync_ops_get_history` paginates and parses details JSON.
- `sync_ops_get_queue_size` returns pending/failed.
- `sync_ops_pause` and `sync_ops_resume` persist state and emit events.
- `sync_ops_get_storage_breakdown` calls `/sync/storage`.
- `sync_ops_get_quarantined_items` returns current quarantine.
- `sync_ops_retry_quarantined_item` requeues a retryable quarantined item.
- `sync_ops_delete_quarantined_item` drops a quarantined item only after explicit input validation.
- `sync_ops_check_device_status` detects revoked/auth unknown.
- `sync_ops_emergency_wipe` clears queue/session/runtime safely.
- `sync_ops_update_synced_setting` and `sync_ops_get_synced_settings` round-trip settings fields.
- `sync_start`, `sync_stop`, `sync_push_now`, `sync_pull_now`, `sync_status`, and `sync_reset_cursor` are available for direct runtime control/devtools paths.

- [ ] Step 2: Implement thin commands over `SyncRuntime`.

Keep all command functions small. Tests should target `*_inner` functions.

- [ ] Step 3: Register commands in Tauri and capabilities.

Update:
- `src-tauri/src/lib.rs`
- `src-tauri/capabilities/default.json`
- `src-tauri/build.rs` if capability checker requires manifest coverage.

- [ ] Step 4: Align renderer DTOs.

Only patch renderer where Rust DTO names differ. Prefer Rust `serde(rename_all = "camelCase")` to avoid renderer churn.

- [ ] Step 5: Graduate `realCommands`.

Add all `sync_ops_*`, `sync_*`, and `sync_attachments_*` commands to `realCommands`.

- [ ] Step 6: Run focused gate.

```bash
pnpm --filter @memry/desktop-tauri cargo:test -- --test commands_sync_ops_test
pnpm --filter @memry/desktop-tauri test -- src/contexts/sync-context.test.tsx
pnpm --filter @memry/desktop-tauri bindings:generate
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity
```

Expected: PASS.

---

## Chunk 13: Runtime E2E And Staging Smoke

**Files:**
- Create: `apps/desktop-tauri/e2e/runtime/specs/sync-two-device.spec.ts`
- Create: `apps/desktop-tauri/e2e/runtime/specs/sync-offline-restart.spec.ts`
- Create: `apps/desktop-tauri/e2e/runtime/specs/sync-attachments.spec.ts`
- Modify: `apps/desktop-tauri/e2e/runtime/helpers/driver.ts` only if multi-device env support needs a helper
- Modify: `apps/desktop-tauri/e2e/runtime/helpers/vault.ts` only if seed data needs sync auth setup

- [ ] Step 1: Add list-only check for scenarios.

```bash
pnpm --filter @memry/desktop-tauri test:e2e:runtime -- --list
```

Expected: lists new sync scenarios.

- [ ] Step 2: Implement two-device note round-trip.

Scenario:
1. Launch device A and B with separate `MEMRY_DEVICE`.
2. Authenticate both against staging/test sync-server.
3. Create/edit note on A.
4. B receives WS notification and note appears in under 3 seconds.

- [ ] Step 3: Implement offline restart drain.

Scenario:
1. Make local task edit offline.
2. Quit app.
3. Relaunch with network restored.
4. Queue drains exactly once and remote has one mutation.

- [ ] Step 4: Implement attachment smoke.

Scenario:
1. Upload small file from note editor.
2. Observe progress.
3. Restart second device.
4. Download attachment into vault attachments folder.

- [ ] Step 5: Run WebSocket reliability stress.

Run a 24-hour CI/manual stress loop if available:
- toggle network or block/unblock sync-server route.
- verify reconnect stays bounded.
- verify queue drains after reconnect.
- verify no duplicate record pushes.
- verify no CRDT duplicate application.

Expected: no data loss, no unbounded reconnect loop, no leaked task handles.

- [ ] Step 6: Run runtime e2e where supported.

```bash
pnpm --filter @memry/desktop-tauri test:e2e:runtime
```

Expected: PASS on supported CI platform. On macOS local, expected skip message is acceptable but must be recorded.

- [ ] Step 7: Run staging smoke manually if CI cannot provision sync-server.

Record:
- server URL
- account used
- two-device timing
- attachment size
- observed failures

---

## Chunk 14: Capability, Binding, And Parity Closure

**Files:**
- Modify: `apps/desktop-tauri/scripts/command-parity-audit.ts`
- Modify: `apps/desktop-tauri/src/generated/bindings.ts`
- Modify: `apps/desktop-tauri/src-tauri/capabilities/default.json`
- Modify: `apps/desktop-tauri/src-tauri/build.rs`

- [ ] Step 1: Regenerate bindings.

```bash
pnpm --filter @memry/desktop-tauri bindings:generate
```

- [ ] Step 2: Run binding check.

```bash
pnpm --filter @memry/desktop-tauri bindings:check
```

Expected: PASS with generated M6 commands.

- [ ] Step 3: Close capability coverage.

```bash
pnpm --filter @memry/desktop-tauri capability:check
```

Expected: PASS. Every registered M6 command has an allow grant.

- [ ] Step 4: Close command parity.

```bash
pnpm --filter @memry/desktop-tauri command:parity
```

Expected:
- `notes_upload_attachment`, `notes_list_attachments`, `notes_delete_attachment` are real.
- all `sync_ops_*` are real.
- quarantined item list/retry/delete is real or explicitly documented as UI-deferred with no live call site.
- no unclassified `sync:*`, `sync-ops:*`, `devices:*`, `attachments:*`, or sync event channels.
- remaining M7/M8/M9 deferrals are explicit.

- [ ] Step 5: Run formatting.

```bash
pnpm --filter @memry/desktop-tauri cargo:fmt
pnpm exec prettier --check apps/desktop-tauri/src apps/desktop-tauri/e2e/runtime
```

Expected: PASS.

---

## Chunk 15: Final Verification Gate

- [ ] Step 1: Rust full gate.

```bash
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
pnpm --filter @memry/desktop-tauri cargo:test
```

Expected: PASS with at least 50 M6 Rust tests.

- [ ] Step 2: Renderer and contract gate.

```bash
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri test:e2e -- --project=webkit
pnpm --filter @memry/contracts typecheck
```

Expected: PASS.

- [ ] Step 3: Generated artifact gate.

```bash
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity
```

Expected: PASS.

- [ ] Step 4: Runtime/staging gate.

```bash
pnpm --filter @memry/desktop-tauri test:e2e:runtime
```

Expected: PASS on supported platform, or documented macOS skip plus CI result link.

Manual/staging acceptance:
- 2-device note edit propagates in under 3 seconds through WS notification.
- concurrent task edits on different fields preserve both fields.
- WS drop reconnects and drains queue within 5 seconds.
- offline edit -> app restart -> reconnect drains queue exactly once.
- sign-out/sign-in preserves CRDT docs and resumes sync.
- modified cert/pin fails closed and emits `certificate-pin-failed`.
- attachment upload/download works against R2 blob API.

- [ ] Step 5: PR body ledger.

Include:
- M6 commands graduated.
- remaining deferrals and milestone.
- local verification output.
- staging smoke evidence.
- any macOS runtime e2e skip note.
- cert pinning implementation choice.

---

## Stop Conditions

Stop and report instead of continuing if:

- cert pinning cannot be implemented without a broad networking rewrite.
- sync-server schemas differ from `packages/contracts` and require server changes larger than parity fixtures.
- M5 CRDT storage lacks enough metadata for safe "exactly once" CRDT push and requires a schema decision.
- runtime e2e proves data loss, duplicate queue drain, or signature bypass.
- any fix requires touching Electron `apps/desktop` implementation beyond read-only parity reference.
