# Seam Inventory — `@memry/sync-client` extraction

**Spec**: [001-mobile-app](../../../specs/001-mobile-app/tasks.md) T015 ·
**Contract**: [platform-adapters.md](../../../specs/001-mobile-app/contracts/platform-adapters.md)

Every file in the extraction surface that touches a platform, mapped to the seam
that will own it. Regenerate with `node packages/sync-client/docs/scan-seams.mjs`.

## Surface scanned

| Tree                          |   Files | Non-test | Platform-touching |
| ----------------------------- | ------: | -------: | ----------------: |
| `apps/desktop/src/main/sync/` |     314 |      145 |                55 |
| `packages/app-core/src/`      |      31 |       26 |                13 |
| `packages/storage-vault/src/` |       5 |        3 |                 1 |
| **Total**                     | **350** |  **174** |            **69** |

"Platform-touching" = imports a node builtin, `electron*`, or a platform-bound
package (`better-sqlite3`, `classic-level`, `keytar`, `y-leveldb`, `undici`,
`chokidar`, `drizzle-orm/better-sqlite3`). The remaining **105 non-test files
are already platform-free** and move into `packages/sync-client/src/` as
import-path-only diffs (T018).

The spec's counts (314 sync files, 18 node-touching in app-core, 1 in
storage-vault) are close but not identical to the measured ones above; where
they differ, the table is what the scanner found on this tree today.

## Findings that change the plan

### 1. Vault file I/O has no seam — RESOLVED 2026-08-23

**Owner decision: seam 6 is widened to `VaultFileSystem`.** The interface lives
in `src/adapters/vault-file-system.ts` and the amendment is recorded in
`contracts/platform-adapters.md` §6. The seam count is still ten. Rows marked
`VaultFiles *` below now belong to seam 6 — the inventory has zero unassigned
files. The original finding is kept below for the reasoning.

#### Original finding

Twenty files read and write **vault files** (note markdown, journals, large-note
overflow, CRDT write-back, attachment staging) straight through `node:fs`. None
of the ten seams covers this:

- `VaultDirectory` resolves and provisions vault **roots**, not their contents.
- `AttachmentStore` stores **attachment bytes** only.
- `CrdtStorePath` is the CRDT store's location, not the vault's files.

Marked `VaultFiles *` in the tables below. This is the "zero unassigned"
requirement failing honestly rather than being papered over.

**Recommendation (accepted)**: widen seam 6 from `VaultDirectory` to a `VaultFileSystem`
that owns both — root resolution plus `readFile`/`writeFile`/`list`/`delete`/
`rename` relative to a vault root. That is the same concern at the same
boundary, so it does not spend the contract's "eleventh seam" budget; it does
still need owner sign-off, because the contract says the ten-seam list is the
decision record's and drift goes through review. ~~**Blocking for T018–T021**~~
— signed off 2026-08-23; no longer blocking.

### 2. Twenty-three files are platform-bound by a _type_, not by code

`bookmark-sync.ts`, `settings-sync.ts`, every `*-sync.ts` record service and
`item-handlers/types.ts` import `BetterSQLite3Database` **as a type only**. The
runtime API they use is Drizzle's driver-agnostic query builder, and Drizzle
ships an `expo-sqlite` driver with the same surface.

These need **no seam**: widening `DrizzleDb` to Drizzle's driver-agnostic
`BaseSQLiteDatabase` makes them platform-free with a type-only diff. The single
alias in `item-handlers/types.ts` is the choke point for most of them.

### 3. Three mechanical substitutions, no seam required

- **`node:events`** (4 files: `engine.ts`, `network.ts`, `websocket.ts`,
  `attachment-events.ts`) — a ~30-line platform-free emitter replaces it.
- **`node:crypto`** (7 files) — `randomUUID` and SHA-256 only. Both exist in
  WebCrypto on both shells; mobile already ships the libsodium-backed
  `crypto` polyfill from G0 (Hermes has no global `crypto`).
- **`node:os`** (4 files) — hostname/tmpdir, absorbed by `DeviceRegistration`
  and `Runtime`.

### 4. Genuinely desktop-only — does not move

`worker.ts`, `worker-bridge.ts` (`worker_threads`), `crdt-preflight-child.ts`
(child-process preflight), `app-core/agent.ts`, `app-core/database.ts`,
`app-core/paths.ts`. These stay in `apps/desktop` and are reached only through
the adapter implementations.

## Assignment

### none — Drizzle type only — 23 files

| File                                     | LOC | Platform imports                      |
| ---------------------------------------- | --: | ------------------------------------- |
| `sync/bookmark-sync.ts`                  |  69 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/calendar-binding-sync.ts`          |  80 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/calendar-event-sync.ts`            |  98 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/calendar-external-event-sync.ts`   |  82 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/calendar-source-sync.ts`           |  80 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/canvas-folder-sync.ts`             |  86 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/canvas-sync.ts`                    | 137 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/custom-icon-sync.ts`               |  68 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/dirty-recovery.ts`                 | 302 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/filter-sync.ts`                    |  73 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/folder-config-sync.ts`             |  80 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/home-page-sync.ts`                 |  68 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/inbox-sync.ts`                     | 108 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/initial-seed.ts`                   |  52 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/item-handlers/note-pin-helpers.ts` |  40 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/item-handlers/types.ts`            |  70 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/manifest-check.ts`                 | 452 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/reminder-sync.ts`                  |  73 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/settings-sync.ts`                  | 208 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/tag-category-sync.ts`              |  94 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/tag-definition-sync.ts`            | 126 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/task-activity-sync.ts`             |  81 | `drizzle-orm/better-sqlite3` _(type)_ |
| `sync/template-sync.ts`                  |  69 | `drizzle-orm/better-sqlite3` _(type)_ |

### VaultFileSystem — 19 files

| File                                              | LOC | Platform imports                               |
| ------------------------------------------------- | --: | ---------------------------------------------- |
| `app-core/folder-view.ts`                         | 370 | `node:fs/promises`, `node:path`                |
| `app-core/folders.ts`                             |  75 | `node:fs/promises`, `node:path`                |
| `app-core/inbox.ts`                               | 830 | `node:fs/promises`, `node:path`                |
| `app-core/locale.ts`                              |  69 | `node:fs/promises`                             |
| `app-core/note-files.ts`                          | 547 | `node:fs/promises`, `node:path`                |
| `app-core/notes.ts`                               | 555 | `node:fs/promises`, `node:path`, `node:util`   |
| `app-core/properties.ts`                          | 188 | `node:fs/promises`, `node:path`                |
| `app-core/sync.ts`                                | 338 | `node:fs/promises`, `node:path`                |
| `app-core/templates.ts`                           | 215 | `node:fs/promises`, `node:path`                |
| `app-core/versions.ts`                            | 181 | `node:crypto`, `node:fs/promises`, `node:path` |
| `storage-vault/note-content-store.ts`             |  84 | `fs/promises`, `path`, `node:crypto`           |
| `sync/crdt-writeback.ts`                          | 917 | `path`                                         |
| `sync/item-handlers/journal-handler.ts`           | 259 | `fs`                                           |
| `sync/item-handlers/note-handler-sync-helpers.ts` | 140 | `fs`                                           |
| `sync/item-handlers/note-handler.ts`              | 725 | `fs`, `path`                                   |
| `sync/journal-sync.ts`                            |  95 | `fs`                                           |
| `sync/large-notes.ts`                             |  87 | `fs`                                           |
| `sync/note-sync.ts`                               | 140 | `fs`, `path`                                   |
| `sync/vault-directory.ts`                         | 208 | `fs`, `path`, `electron`                       |

### none — desktop-only — 5 files

| File                    | LOC | Platform imports                                                                                              |
| ----------------------- | --: | ------------------------------------------------------------------------------------------------------------- |
| `app-core/agent.ts`     | 215 | `node:child_process`                                                                                          |
| `app-core/database.ts`  | 202 | `better-sqlite3`, `drizzle-orm/better-sqlite3`, `drizzle-orm/better-sqlite3/migrator`, `node:fs`, `node:path` |
| `app-core/paths.ts`     |  91 | `node:fs/promises`, `node:path`, `node:url`                                                                   |
| `sync/worker-bridge.ts` | 459 | `worker_threads`, `path`                                                                                      |
| `sync/worker.ts`        | 182 | `worker_threads`                                                                                              |

### AttachmentStore — 2 files

| File                        | LOC | Platform imports                                                      |
| --------------------------- | --: | --------------------------------------------------------------------- |
| `sync/attachment-outbox.ts` | 216 | `fs`, `crypto`                                                        |
| `sync/attachments.ts`       | 993 | `node:fs`, `node:fs/promises`, `node:crypto`, `node:path`, `electron` |

### CrdtPersistence — 2 files

| File                         | LOC | Platform imports                   |
| ---------------------------- | --: | ---------------------------------- |
| `sync/crdt-pending-notes.ts` | 430 | `crypto`, `fs`, `path`, `electron` |
| `sync/crdt-persistence.ts`   | 255 | `y-leveldb`, `fs`, `os`            |

### CrdtStorePath — 2 files

| File                      | LOC | Platform imports                   |
| ------------------------- | --: | ---------------------------------- |
| `sync/crdt-store-move.ts` |  48 | `fs`                               |
| `sync/crdt-store-path.ts` | 308 | `path`, `crypto`, `fs`, `electron` |

### DeviceRegistration — 2 files

| File                          | LOC | Platform imports |
| ----------------------------- | --: | ---------------- |
| `sync/device-registration.ts` | 286 | `electron`, `os` |
| `sync/linking-service.ts`     | 786 | `os`             |

### HttpClient — 2 files

| File                  | LOC | Platform imports |
| --------------------- | --: | ---------------- |
| `sync/http-client.ts` | 343 | `electron`       |
| `sync/websocket.ts`   | 373 | `events`         |

### none — EventEmitter — 2 files

| File                        | LOC | Platform imports |
| --------------------------- | --: | ---------------- |
| `sync/attachment-events.ts` |  91 | `node:events`    |
| `sync/engine.ts`            | 873 | `events`         |

### none — node:crypto — 2 files

| File                                          | LOC | Platform imports |
| --------------------------------------------- | --: | ---------------- |
| `sync/blocknote-converter.ts`                 | 766 | `node:crypto`    |
| `sync/item-handlers/agent-message-handler.ts` | 243 | `node:crypto`    |

### AttachmentStore + VaultFileSystem — 1 file

| File                          | LOC | Platform imports |
| ----------------------------- | --: | ---------------- |
| `sync/attachment-backfill.ts` | 112 | `fs`, `path`     |

### CertificatePinning — 1 file

| File                          | LOC | Platform imports                                    |
| ----------------------------- | --: | --------------------------------------------------- |
| `sync/certificate-pinning.ts` | 212 | `node:https`, `node:tls`, `node:crypto`, `electron` |

### CrdtPreflight — 1 file

| File                     | LOC | Platform imports                          |
| ------------------------ | --: | ----------------------------------------- |
| `sync/crdt-preflight.ts` | 260 | `child_process`, `os`, `path`, `electron` |

### CrdtPreflight (desktop-only impl) — 1 file

| File                           | LOC | Platform imports |
| ------------------------------ | --: | ---------------- |
| `sync/crdt-preflight-child.ts` |  98 | `fs`             |

### CrdtProvider — 1 file

| File                    |  LOC | Platform imports                    |
| ----------------------- | ---: | ----------------------------------- |
| `sync/crdt-provider.ts` | 1414 | `fs/promises`, `crypto`, `electron` |

### HttpClient + Runtime — 1 file

| File              | LOC | Platform imports     |
| ----------------- | --: | -------------------- |
| `sync/network.ts` | 169 | `events`, `electron` |

### Runtime — 1 file

| File              |  LOC | Platform imports |
| ----------------- | ---: | ---------------- |
| `sync/runtime.ts` | 1066 | `electron`       |

### Runtime (logger) — 1 file

| File                        | LOC | Platform imports        |
| --------------------------- | --: | ----------------------- |
| `sync/content-sync-base.ts` | 134 | `electron-log` _(type)_ |

---

`VaultFileSystem` rows belong to seam 6 (finding 1, resolved). Every row is
assigned; the inventory has no unassigned files.
