# Seam Inventory — `@memry/sync-client` extraction

**Spec**: [001-mobile-app](../../../specs/001-mobile-app/tasks.md) T015 ·
**Contract**: [platform-adapters.md](../../../specs/001-mobile-app/contracts/platform-adapters.md)

Every file in the extraction surface that touches a platform, mapped to the seam
that will own it. Regenerate with `node packages/sync-client/docs/scan-seams.mjs`.

## Surface scanned

State after the G1 extraction (regenerate with the scanner for live numbers):

| Tree                          | Files | Non-test | Platform-touching |
| ----------------------------- | ----: | -------: | ----------------: |
| `apps/desktop/src/main/sync/` |   253 |       99 |    27 (+6 adapter) |
| `packages/app-core/src/`      |    14 |       13 |                 0 |
| `packages/storage-vault/src/` |     5 |        3 |                 1 |

`packages/sync-client/src/` now holds **79 non-test modules** extracted from
this surface. The original T015 scan (174 non-test files, 69 platform-touching,
105 platform-free) is preserved in git history; the tables below are the
post-extraction remainder.

Of what remains in the desktop sync tree: the `sync/adapters/` rows are the
sanctioned platform edge (T020 — electron/node imports are legal there by
design); every other platform-touching row is the desktop implementation behind
its seam. **60 platform-free files also remain in desktop** (engine/, the
push/pull coordinators, the item-handler registry and its vault-bound handlers,
decrypt/encrypt, apply-item, …): they form one dependency knot that reaches the
concrete `http-client`/`crdt-provider`/vault/database/i18n/store modules, so
they move only when the engine consumes the seams instead of the concrete
modules — a behaviour-affecting refactor deliberately split out of the
mechanical extraction.

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

## Assignment — post-extraction remainder

### VaultFileSystem — 9 files

| File | LOC | Platform imports |
| --- | ---: | --- |
| `storage-vault/note-content-store.ts` | 84 | `fs/promises`, `path`, `node:crypto` |
| `sync/crdt-writeback.ts` | 917 | `path` |
| `sync/item-handlers/journal-handler.ts` | 259 | `fs` |
| `sync/item-handlers/note-handler-sync-helpers.ts` | 140 | `fs` |
| `sync/item-handlers/note-handler.ts` | 725 | `fs`, `path` |
| `sync/journal-sync.ts` | 95 | `fs` |
| `sync/large-notes.ts` | 87 | `fs` |
| `sync/note-sync.ts` | 140 | `fs`, `path` |
| `sync/vault-directory.ts` | 208 | `fs`, `path`, `electron` |

### desktop adapter layer (platform imports legal) — 6 files

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/adapters/attachment-store.ts` | 76 | `node:fs`, `node:path`, `node:crypto` |
| `sync/adapters/crdt-preflight.ts` | 49 | `node:fs` |
| `sync/adapters/crdt-store-path.ts` | 23 | `node:fs` |
| `sync/adapters/device-registration.ts` | 95 | `node:fs`, `node:path`, `node:crypto` |
| `sync/adapters/vault-file-system.ts` | 215 | `node:fs`, `node:path`, `node:crypto` |
| `sync/adapters/wiring.ts` | 108 | `electron` |

### AttachmentStore — 2 files

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/attachment-outbox.ts` | 215 | `fs` |
| `sync/attachments.ts` | 993 | `node:fs`, `node:fs/promises`, `node:crypto`, `node:path`, `electron` |

### CrdtPersistence — 2 files

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/crdt-pending-notes.ts` | 240 | `crypto`, `fs`, `path`, `electron` |
| `sync/crdt-persistence.ts` | 255 | `y-leveldb`, `fs`, `os` |

### CrdtStorePath — 2 files

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/crdt-store-move.ts` | 48 | `fs` |
| `sync/crdt-store-path.ts` | 308 | `path`, `crypto`, `fs`, `electron` |

### DeviceRegistration — 2 files

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/device-registration.ts` | 286 | `electron`, `os` |
| `sync/linking-service.ts` | 786 | `os` |

### none — desktop-only — 2 files

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/worker-bridge.ts` | 459 | `worker_threads`, `path` |
| `sync/worker.ts` | 182 | `worker_threads` |

### AttachmentStore + VaultFileSystem — 1 file

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/attachment-backfill.ts` | 112 | `fs`, `path` |

### CertificatePinning — 1 file

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/certificate-pinning.ts` | 212 | `node:https`, `node:tls`, `node:crypto`, `electron` |

### CrdtPreflight — 1 file

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/crdt-preflight.ts` | 260 | `child_process`, `os`, `path`, `electron` |

### CrdtPreflight (desktop-only impl) — 1 file

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/crdt-preflight-child.ts` | 98 | `fs` |

### CrdtProvider — 1 file

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/crdt-provider.ts` | 1413 | `fs/promises`, `electron` |

### HttpClient — 1 file

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/http-client.ts` | 293 | `electron` |

### HttpClient + Runtime — 1 file

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/network.ts` | 169 | `electron` |

### Runtime — 1 file

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/runtime.ts` | 1068 | `electron` |

### Runtime (logger) — 1 file

| File | LOC | Platform imports |
| --- | ---: | --- |
| `sync/content-sync-base.ts` | 134 | `electron-log` *(type)* |

---

`VaultFileSystem` rows belong to seam 6 (finding 1, resolved). Adapter-layer rows are the platform edge, not extraction gaps.
