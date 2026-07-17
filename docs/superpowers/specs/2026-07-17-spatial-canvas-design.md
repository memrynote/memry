# Spatial Canvas (Excalidraw) — Design & Implementation Plan

- **Date:** 2026-07-17
- **Status:** Draft / design
- **Branch:** `excalidraw` (worktree)
- **Author:** design pass grounded in a multi-agent codebase map (7 explorers) + adversarial critique (sync data-loss / migration-compat / crypto-assets / render-perf), plus context7 verification of the Excalidraw public API.
- **Library:** **Excalidraw (MIT, free)** — `/excalidraw/excalidraw`. tldraw rejected on license; React Flow rejected earlier (no freehand ink). See memory `spatial-canvas-excalidraw-direction`.

> Language note: written in English to match every other spec under `docs/superpowers/specs/**`. Ask if a Turkish version is wanted.

---

## 1. Goal & product shape

A Heptabase-style **spatial canvas**: open a canvas; draw/write freely with Apple Pencil / mouse / touch; drop **real MemryNote items** (note / task / calendar event) as cards; move them around; and **connect** them with arrows. Capture-first, connect-later: drop a card without filing, edit the note later.

The canvas is a **spatial VIEW of real notes/tasks/events**, never a separate silo. A card holds only a **reference** (`{entityType, entityId}`) — never a content snapshot. The single source of truth stays the real DB row / vault file.

### Non-goals (v1)

- No per-element CRDT / real-time co-editing of a canvas (whole-document LWW + conflict-copy instead — see §5.4).
- No native React Native canvas. DOM-only React; Electron now, iPad web/PWA + Expo **WebView** later (§8).
- No reflection of spatial arrows into Memry's links/backlinks graph in v1 (§6, deferred with rationale).
- Live in-place editing of cards **is a goal** (hybrid rectangle + overlay, §7.1 / M6). Deferred/out: `renderEmbeddable`-as-primary (timeboxed spike only) and real-time multi-user co-editing of a canvas (§5.4).

---

## 2. Architecture decision summary

| Decision            | Choice                                                                                                                                                                            | Why                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas document     | One Excalidraw scene JSON `{elements, appState, files}` → **one encrypted blob per canvas**                                                                                       | Excalidraw is element-based, not a node-graph; a scene serializes cleanly via `serializeAsJSON`.                                                                                         |
| Sync model          | New **`canvas` record sync type** (NOT CRDT)                                                                                                                                      | A scene is one opaque blob; per-element merge was explicitly rejected. Record-handler machinery (D1 metadata + R2 blob) already exists.                                                  |
| Conflict resolution | Whole-document **LWW + hand-built conflict-copy** inside the canvas handler                                                                                                       | The generic record merge path is a destructive LWW overwrite; "never lose ink" requires a real second-row copy (§5.4, **blocker fix**).                                                  |
| Item card           | `rectangle` element + `customData: {entityType, entityId}`                                                                                                                        | `customData: Record<string,any>` is the documented Excalidraw app-data hook.                                                                                                             |
| Card content        | **Live editable cards** — `rectangle` (geometry/arrows) + DOM overlay editor; idle = read-only A4 preview, active (double-click) = full in-place CRUD; each card has a ↗ redirect | Excalidraw has no live-React native element; hybrid overlay keeps arrows **and** editing working. `renderEmbeddable` fights live editing + unverified arrow-binding → spike only (§7.1). |
| Linking             | **bound arrows** (`start.id` / `end.id`) within the scene only                                                                                                                    | Arrows follow moved boxes natively; graph reflection is fragile → deferred.                                                                                                              |
| Assets              | Externalize inline base64 images to **`memry-file://` + R2** via the attachment pipeline                                                                                          | `files` (BinaryFiles) inline base64 blows the 5 MB push cap; reuse the existing chunked/encrypted attachment path.                                                                       |
| Persistence         | New `canvases` + `canvas_entity_refs` tables in the **DATA db** (source of truth)                                                                                                 | Index db is a rebuildable cache (`rebuildIndex()` deletes it). Canvas data must survive index rebuild.                                                                                   |
| Crypto              | **Reuse the existing vault key** via `encryptItemForPush` / `decryptItemFromPull`; no new escrow                                                                                  | Fresh random fileKey + fresh nonce per push; Ed25519 signs ciphertext; verified sound by the crypto critic.                                                                              |
| Surface             | New `canvas` **tab kind** (entity-based, non-singleton) + sidebar "Canvases" section                                                                                              | The renderer has no router; tabs _are_ routes.                                                                                                                                           |
| Flag                | Hidden **`spatialCanvas` boolean** (default OFF) in `FeaturesSettingsSchema` → later promote to `FEATURE_KEYS`                                                                    | Group-blob settings merge means a new default-off key is safe for existing installs.                                                                                                     |

### Excalidraw API facts (verified via context7, `/excalidraw/excalidraw`)

- `customData: Record<string, any>` — optional per element; set at init or updated via API.
- Bound arrows: `convertToExcalidrawElements([...])` skeleton with `start:{id}`/`end:{id}` referencing element ids; full elements carry `startBinding`/`endBinding`/`boundElements`; the arrow re-routes when bound boxes move.
- `onChange(elements, appState, files) => void`. Guarded by `isLoading` (does **not** fire during init) and fires for **appState UI changes too** (e.g. `viewBackgroundColor`) → **debounce + dedupe** persistence.
- `serializeAsJSON({elements, appState})` → JSON string; strips deleted elements + volatile appState. `window.EXCALIDRAW_EXPORT_SOURCE` customizes the `source` field.
- `excalidrawAPI.updateScene({elements, appState, captureUpdate})` with `CaptureUpdateAction.*` to control undo history.
- `initialData: {elements, appState, files, scrollToContent}` (may be a Promise); if `scrollToContent:false`, supply `appState.scrollX/scrollY`.
- Assets: image elements carry `fileId`; binaries live in `files` (base64 dataURL keyed by fileId, `status: pending|saved`).
- `renderEmbeddable(element, appState) => JSX | null` overrides iframe embeddable rendering.
- `langCode` prop + `languages`/`defaultLang` exports drive Excalidraw's **own** toolbar i18n (independent of Memry's `i18n:check`).
- Frames require **child-before-parent** ordering in the `elements` array.
- Freedraw pressure: `pressures[]` + `simulatePressure` via perfect-freehand, fed by Chromium `PointerEvent.pressure`. **⚠ Runtime-verify** on real hardware (context7 did not expose the field explicitly).

---

## 3. Data model

### 3.1 Tables (DATA db — `packages/db-schema/src/schema/canvas.ts`)

Model on `agent-conversations.ts` (ciphertext text columns + JSON clock columns) and `home-pages.ts` (simplest additive table). Register with `export * from './schema/canvas.ts'` in `packages/db-schema/src/data-schema.ts`.

```ts
// canvases — one row per canvas document
export const canvases = sqliteTable(
  'canvases',
  {
    id: text('id').primaryKey(), // generateId() (nanoid 21) — grep-confirm 'canvas' id is free
    vaultId: text('vault_id').notNull(),
    title: text('title'), // plaintext title is fine (matches notes cache); OR titleCiphertext if we want it E2E
    snapshotCiphertext: text('snapshot_ciphertext').notNull(), // app-encrypted scene JSON (at-rest, mirrors agent_conversations)
    vectorClock: text('vector_clock', { mode: 'json' }).$type<VectorClock>().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'), // soft-delete tombstone (see §5.4 delete-vs-edit)
    lastSyncedAt: integer('last_synced_at'),
    clock: text('clock', { mode: 'json' }).$type<VectorClock>() // sync clock (nullable until first local mutation)
  },
  (t) => [index('canvases_by_vault').on(t.vaultId)]
)

// canvas_entity_refs — advisory index of which entities a canvas references (NOT authoritative)
export const canvasEntityRefs = sqliteTable(
  'canvas_entity_refs',
  {
    canvasId: text('canvas_id').notNull(),
    entityType: text('entity_type').notNull(), // 'note' | 'task' | 'calendar_event'
    entityId: text('entity_id').notNull()
  },
  (t) => [
    primaryKey({ columns: [t.canvasId, t.entityType, t.entityId] }),
    index('idx_canvas_refs_entity').on(t.entityType, t.entityId),
    foreignKey({ columns: [t.canvasId], foreignColumns: [canvases.id] }).onDelete('cascade')
  ]
)
```

Notes:

- `data.db` opens with `foreign_keys = ON` (`database/client.ts`), so the FK cascade works. `index.db` has FKs off — another reason this belongs in the data db.
- `canvas_entity_refs` is **advisory** (drives future backlink/search JOINs and dereference GC); the authoritative geometry lives inside `snapshotCiphertext`. Deleting a referenced note does **not** cascade-clean these rows (FK is `canvas_id`→`canvases`, not `entity_id`→entity) — always LEFT JOIN + null-check, and prune on `notes:deleted`/`tasks:deleted`/`calendar:changed` (§6, medium risk).
- Optional/nullable columns must be coalesced to `null` (not `undefined`) in `.values()` — `link-queries.ts` pattern.

### 3.2 Migration — `apps/desktop/src/main/database/drizzle-data/0035_spatial_canvas.sql`

- **Next number is 0035** on this branch (highest = `0034_tag_nocase.sql`, `_journal.json` max idx = 34). **⚠ 0035 is also reserved by the `custom-themes` and `template-sync` branches** — first-to-merge keeps 0035; the rest renumber to 0036/0037 and bump `_journal.json` before merge. Never renumber a migration a released build already applied.
- **Hand-written** (Drizzle snapshots broken past 0021 — do **not** run `db:generate`). Follow `0029_agent_chat.sql`:
  - `CREATE TABLE IF NOT EXISTS canvases (...)` → `--> statement-breakpoint`
  - `CREATE TABLE IF NOT EXISTS canvas_entity_refs (... FOREIGN KEY(canvas_id) REFERENCES canvases(id) ON DELETE cascade)`
  - `CREATE INDEX IF NOT EXISTS ...`
  - Additive only. No `ALTER`/`DROP`/rename. Leading "hand-written" comment.
- Append a `_journal.json` entry: `{"idx":35,"version":"6","when":<epoch_ms>,"tag":"0035_spatial_canvas","breakpoints":true}`. Do **not** create a `meta/0035_snapshot.json`. (The entry `version` is `"6"` even though the file's top-level `version` is `"7"` — copy the 0034 entry's shape.)
- **Freeze the SQL once any build ships it** (the migrator hash-tracks applied migrations).

### 3.3 Sync payload — `packages/contracts/src/sync-payloads.ts`

```ts
export const CanvasSyncPayloadSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  scene: z.string(), // serializeAsJSON output (image files externalized to memry-file:// refs)
  clock: VectorClockSchema,
  deletedAt: z.number().nullable()
})
```

- Zod v4: use `z.record(z.string(), z.unknown())` if validating raw scene objects — bare `z.record(z.unknown())` throws in `safeParse`.

---

## 4. IPC surface (`packages/contracts` → generated invoke map → main → preload → renderer)

Two coexisting patterns; **use the generated-RPC path** (like `tasks`/`notes`) for typed `window.api.canvas` with least boilerplate; the asset upload channel needs binary, handled via the `implementation` string escape hatch (`packages/rpc/src/notes.ts` `uploadAttachment` precedent).

Steps:

1. `packages/contracts/src/ipc-channels.ts` → `CanvasChannels` (`canvas:create|get|update|delete|list|upload-asset|get-asset|list-assets`, events `created|updated|deleted`). If it pushes the file past the ~800-line ceiling, extract to `canvas-channels.ts` and re-export (mirror `notes-channels.ts`).
2. `packages/contracts/src/canvas-api.ts` (Zod request schemas + response interfaces; asset upload uses `data: z.instanceof(ArrayBuffer).or(z.array(z.number()))`). Register in `packages/contracts/package.json` `exports` (`"./canvas-api": "./src/canvas-api.ts"`) — the `index.ts` barrel is `export {}`, subpaths are the real entry.
3. `packages/rpc/src/canvas.ts` (`defineDomain`/`defineMethod`/`defineEvent`); export `CanvasClientAPI`/`CanvasSubscriptions`. Register in `packages/rpc/src/index.ts` (`rpcDomains` **and** `GeneratedRpcApi`) + `package.json` exports.
4. `apps/desktop/src/main/ipc/canvas-handlers.ts` (`registerCanvasHandlers`/`unregisterCanvasHandlers` via `ipcMain.handle(channel, createValidatedHandler(schema, fn))` or `registerCommand`); decode binary with `Buffer.from(new Uint8Array(input.data))`; emit events via `BrowserWindow.getAllWindows().forEach(w => w.webContents.send(...))`. Wire into `apps/desktop/src/main/ipc/index.ts`.
5. `pnpm ipc:generate` → `pnpm ipc:check` (runs in `pretypecheck`; commit both generated files). Channel args must be **string-literal constants**; one channel = one handler.
6. `apps/desktop/src/renderer/src/services/canvas-service.ts` (`createWindowApiForwarder(() => window.api.canvas)` + `on*` wrappers).

---

## 5. Sync & E2E encryption (the critical path)

Follow the **`adding-sync-item-type` skill** (`/Users/h4yfans/.claude/skills/adding-sync-item-type/SKILL.md`) — copy `filter-handler.ts` as the record template, **but override the merge branch** (§5.4).

### 5.1 Type registration

Add `'canvas'` to **four** as-const arrays in `packages/contracts/src/sync-api.ts`: `SYNC_ITEM_TYPES`, `RECORD_SYNC_ITEM_TYPES`, `RECORD_CLOCK_REQUIRED_ITEM_TYPES`, `ENCRYPTABLE_ITEM_TYPES`. **Not** `CRDT_SYNC_ITEM_TYPES` (that's Yjs-only). Missing `ENCRYPTABLE` → encryption silently drops the type.

### 5.2 Desktop wiring (14-step skill, condensed)

- `item-handlers/canvas-handler.ts extends BaseItemHandler<CanvasSyncPayload>` (type, schema, `applyUpsert`, `applyDelete`, `fetchLocal`, `buildPushPayload`, `markPushSynced`, `seedUnclocked`).
- Register `['canvas', canvasHandler]` in `item-handlers/index.ts`; add adapter in `runtime.ts` `createSyncAdapterRegistry`.
- `sync/canvas-sync.ts` service (copy `filter-sync.ts`); `offline-clock.ts` `incrementCanvasClockOffline`; `local-mutations.ts` registry entry `{type:'canvas', kind:'record', local:{enqueueCreate/Update/Delete}}` — **every** canvas mutation must call these enqueue fns or edits seed once then never resync.
- **`manifest-check.ts` canvas branch in `getLocalSyncableItems()`** — see §5.3 blocker.

### 5.3 Server wiring & deploy order (**server before desktop**)

- The sync-server is storage-agnostic: `sync_items.item_type` is opaque TEXT — **no D1 migration needed**.
- **Only mandatory server change:** add `case 'canvas': return '<domain>'` to the exhaustive `toSyncDomain()` switch in `apps/sync-server/src/services/sync-telemetry.ts` (typecheck fails otherwise).
- The server allowlist is the shared contract `RECORD_SYNC_ITEM_TYPES` (materialized as `RECORD_SYNC_ITEM_TYPE_SET`/`_PLACEHOLDERS` in `services/sync.ts`). Until the server ships with `canvas` in that list it **rejects** canvas pushes (`VALIDATION_ERROR`) and filters canvas out of pull/changes/manifest. → **Deploy sync-server first (GitHub Actions), then release desktop.**

**⚠ BLOCKER — pull-side negotiation gap (this branch).** The `X-Memry-Sync-Types` header + frozen LEGACY list (PR #754) is **not merged here** (grep-confirmed: only `X-Memry-Vault-Id`, `X-App-Version`, `Authorization` exist). Deploy-order guards only **push** (`processPushItem` `VALIDATION_ERROR`, `services/sync.ts:332-334`). The dangerous direction is **pull**: a new server returns `canvas` pages to a still-old client; the old client's `apply()` returns `'skipped'` (`apply-item.ts:33-36`) but `pull-coordinator.ts:224` advances `LAST_CURSOR` unconditionally — after that client upgrades, incremental `/sync/changes` never re-delivers those below-cursor items. Recovery hinges **entirely** on the 30-min manifest re-pull (`manifest-check.ts`), which itself is broken without the §5.3 canvas branch.

**DECIDED (Kaan): land #754 first.** Block canvas _sync_ (M4+) until #754 pull-side negotiation (`X-Memry-Sync-Types`, frozen LEGACY list) merges, so `getChanges`/`getManifest` filter to the _requesting client's_ supported types and canvas is "negotiated-only" — this closes both push and pull directions mechanically, not by deploy discipline. Local-only canvas work (M1–M3: draw, cards, links) proceeds in parallel and does **not** depend on #754. The interim flag-only mitigation (manifest self-heal + `sync_skipped_unknown_type` counter) is the fallback **only** if we later choose to ship sync before #754 — not the plan of record. Keep the `sync_skipped_unknown_type` counter anyway as a mixed-version tripwire.

**§5.3 canvas branch (mandatory, skill step 10):** add an `addLocalItem` block to `getLocalSyncableItems()` in `manifest-check.ts` querying `canvases WHERE clock IS NOT NULL` (mirror the tasks block). Without it: (a) a canvas whose push failed is never re-enqueued by the `!serverRef` safety net → permanent outbound loss; (b) every canvas-capable device flags its own canvases as "server-only" forever → a full cursor-reset re-pull every 30 min on every device. Add a `manifest-check.test.ts` asserting a synced canvas is **not** reported server-only.

### 5.4 Conflict resolution — LWW + **hand-built** conflict-copy (**blocker**)

The design promises "never lose ink". The generic record merge path does **not** deliver it: `filter-handler.ts`'s `merge` branch is a plain `tx.update().set(...)` LWW overwrite, and the `'conflict'` return only fires `handleConflict` **after** the row is already clobbered (it re-reads the overwritten row). No losing snapshot is preserved anywhere.

**Fix — inside `canvas-handler.ts` `applyUpsert`, on `resolution.action === 'merge'`, within the same `ctx.db.transaction`:**

1. Read the current local canvas row.
2. INSERT it as a **new** `canvases` row (new id, `title` suffixed `(conflict copy)`, fresh clock).
3. Enqueue that new row for push (so both devices keep both snapshots).
4. _Then_ apply the LWW overwrite of the original row with remote data.

`handleConflict` in `pull-coordinator.ts` is **too late** to be the copy site. Add `canvas-handler.test.ts` asserting a concurrent-clock apply leaves **two** canvas rows.

**Accepted, documented consequences:**

- Whole-doc LWW is unmergeable by construction — even a correct conflict-copy leaves the user "My Canvas" + "My Canvas (conflict copy)" with no scene-merge tool. Mitigate frequency: **debounced push + push on blur/close** (fewer true concurrents); surface conflict copies clearly in the sidebar list.
- **Delete-vs-concurrent-edit:** `applyDelete` returns `'skipped'` on concurrent clocks, so a canvas deleted on B while edited on A can **resurrect** on B. Acceptable given "never lose ink", but make it intentional via the `deletedAt` soft-delete tombstone so a resurrection is visible/undoable rather than silent.

### 5.5 Crypto (verified sound — no change to primitives)

Reuse `encryptItemForPush` (`apps/desktop/src/main/sync/encrypt.ts`) / `decryptItemFromPull` (`decrypt.ts`) via the handler registry. Fresh random fileKey + fresh 24-byte nonce per push; fileKey wrapped under the vault key (`getOrInitializeLocalVaultKey(db, getOrCreateVaultUuid(db))`); Ed25519 signature over the base64 ciphertext fields (`CBOR_FIELD_ORDER.SYNC_ITEM`), **verified before decrypt**; AEAD is all-or-nothing (no partial plaintext). `secureCleanup()` keys in a `finally`.

**Read-only-on-failure guarantee** comes only from routing through the standard pipeline: `decryptSingleItem` returns a `DecryptionFailure` (never throws); `pull-coordinator` quarantines signature failures / corrupt-tracks crypto failures and never applies under `suppressPushDuringPull=true`. **Do not** build a bespoke "load → repair → re-serialize → push" path for schema-migrating old Excalidraw JSON — a failed/partial decrypt could overwrite good local ink under LWW or generate an outbound push from pulled data. On any `DecryptionFailure`: load the canvas **read-only**, never re-serialize + push.

### 5.6 Size cap (**high** — silent-drop risk)

`encryptItemForPush` throws `Item too large` when `content.byteLength * 1.37 > 5MB`, measured on the **uncompressed** JSON (before `compressPayload`). In the worker path the throw becomes `queue.markFailed` → retried → purged after 7 days, **with no UI error**; in the non-worker fallback one oversized item fails the whole batch. Unbounded freehand ink (point arrays) can silently push a canvas past the cap so it stops syncing, and whole-doc LWW then diverges with no signal.

**Fix:** externalize image assets (§7); keep `compressPayload` in the pipeline; add a **pre-push size guard in the canvas save path** that surfaces a user-facing "canvas too large to sync" error (`extractErrorMessage` + a toast) well before the 5 MB server cap; emit a telemetry event; treat `markFailed` on a canvas item as a surfaced sync error, not a silent drop. Long-term: segment/cap ink or split very large scenes.

---

## 6. Asset externalization (`memry-file://` + R2)

Excalidraw inlines images as base64 in `files`. Externalize to keep the scene JSON small and under the push cap.

**Pipeline (reuse `AttachmentSyncService`, `apps/desktop/src/main/sync/attachments.ts`):** decode base64 → write under `{vault}/attachments/{canvasId}/<name>` → reference in the scene as `toMemryFileUrl(absPath)` (`memry-file://local/...`, already CSP-whitelisted & path-allowlisted) instead of the `data:` URI → `attachmentEvents.onSaved`/`UploadQueue.enqueue` pushes encrypted chunks to R2. On another device `attachmentEvents.onDownloadNeeded` restores the file (call `markWritebackIgnored(diskPath)` first to avoid a re-upload loop). Never hand-concat the `memry-file://` URL (Windows drive-letter → 403); always `toMemryFileUrl`.

**Two gaps that MUST be fixed before enabling externalization (both `high`):**

1. **No dereference/GC.** `blob_chunks.ref_count` is only ever decremented for cancelled/expired _upload sessions_ (`routes/blob.ts`, `services/cleanup.ts`) — never when a completed attachment's referencing canvas/image is deleted. Canvas makes deletion routine → monotonic R2 growth to the plan cap. **Add** a server endpoint that decrements `ref_count` for a dereferenced `attachmentId` (mirror the cancel-session decrement) + a client GC that on canvas save/delete diffs current scene `fileId`s against previously-uploaded ids and calls it; let `cleanupOrphanedBlobChunks` do the physical delete at `ref_count<=0`.
2. **No dedup.** `uploadAttachment` mints a **random** fileKey + random `attachmentId` per call → identical images produce different ciphertext → different `encryptedHash` → zero server-side dedup. Excalidraw paste/duplicate multiplies this. **Fix:** derive the per-image fileKey **deterministically from the plaintext content hash** (convergent-encryption tradeoff) OR dedup on disk by content-hashed filename + skip re-upload if the chunk hash exists. Either keeps the `memry-file://` ref stable across scenes.
3. **Multi-asset reference tracking.** `recordUploadedAttachment` writes a single-element `attachmentReferences:[id]` that **replaces** — useless for a canvas with many images. Give canvas its own N-asset reference set keyed by `canvasId` (append/replace the full set from scene `fileId`s each save) and drive the dereference call off the set-difference between successive saves.

---

## 7. Render & item cards

### 7.1 Rendering strategy — **live editable cards (DECIDED)**

**Requirement (Kaan):** cards are **not** static previews. A note card shows the note in a proper "A4 white page" nest and, on double-click, the user does **full in-place CRUD** on the note content. Same for task and calendar-event cards — edit the entity in place on the canvas. Every card also has a **"↗ open in new tab" redirect button** (note→note tab, task→Tasks page + drawer, event→Calendar focus; §7.3).

Excalidraw has **no live-React native element** (no `ShapeUtil`). Two ways to host live React on the canvas, evaluated:

| Option                               | How                                                                                                                                                                                                                                                                   | Verdict                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`renderEmbeddable`**               | Card = an `embeddable` element (`customData:{entityType,entityId}` confirmed supported); Excalidraw manages transform/select/resize/z-order.                                                                                                                          | **Not primary.** Embeddable has a "select-vs-interact" active-state gate built for iframes (YouTube/Figma) that fights live text editing + keyboard capture; **arrow-binding to `embeddable` is unverified** (binding is well-supported for `rectangle`). Worth a timeboxed spike, not the plan of record. |
| **Rectangle + DOM overlay (HYBRID)** | Card = a real `rectangle` (`customData:{entityType,entityId}`) for geometry/selection/resize/**arrow-binding**; a React **overlay layer** positioned over each rectangle's screen rect (from `appState.scrollX/scrollY/zoom` via `onChange`) renders the live editor. | **PRIMARY.** Arrows bind to the rectangle and follow moves natively; full control over the editor, pointer routing, and per-card virtualization. This is the standard Heptabase-style approach.                                                                                                            |

**Primary architecture — hybrid rectangle + overlay:**

- One transparent/blank Excalidraw **rectangle per card** holds geometry, selection, resize handles, arrow bindings, and `customData:{entityType,entityId}`. It lives in the scene blob (positions/links persist + sync).
- A single **overlay React layer** (sibling to `<Excalidraw>`, `position:absolute`, `pointer-events:none` by default) transforms with the scene (`translate(scrollX*zoom, scrollY*zoom) scale(zoom)`), re-computed on `onChange`. For each **visible** card rectangle it renders a card div at that rectangle's screen position.
- **Two card states** (this is the perf strategy — do not mount heavy editors everywhere):
  - **Idle (default):** a lightweight **read-only rich preview** — for notes the A4-page look with title + a read-only BlockNote/markdown render of the cached body; for tasks a status/title/due chip; for events title/time. `pointer-events:none` so canvas pan/draw passes through.
  - **Active (double-click):** mount the **full live editor** for that **one** card, `pointer-events:auto` so it captures input:
    - **note** → the real BlockNote editor bound to the note's Y.Doc via `yjs-ipc-provider` (reuse `ContentArea` in an embedded layout mode, or extract a slimmer `<EmbeddedNoteEditor noteId>`). Edits flow through the existing CRDT path — same as the note tab.
    - **task** → reuse `components/tasks/task-detail-drawer.tsx` fields (already a task editor) rendered inline; writes via `tasks` IPC.
    - **calendar_event** → **needs a new small inline form** (no reusable event-edit component exists today); writes via `calendar` IPC.
  - Click-away / Escape returns the card to idle and unmounts the heavy editor.
- **Redirect button** (`↗`) on each card → `openTab(...)` with the §7.3 `viewState` deep-link. Editing in place and opening in a tab are independent affordances.
- **Virtualization:** only render overlay cards whose rectangles intersect (a padded) viewport; unmount off-screen. Only ever ONE active heavy editor at a time (or a small N) to bound cost.

**Pointer model (the hard part):** the overlay is `pointer-events:none` except on the active card, so drawing/panning/selecting on the canvas still works everywhere else; double-click on a card promotes it to active (pointer-events:auto). Card **move/resize** is driven by the underlying Excalidraw rectangle (drag the rectangle → `onChange` → overlay follows), so the overlay never needs its own drag logic. This split must be validated early (spike) — it is the central UX risk (§15 R15).

**Yjs caveat:** a note open in a tab **and** active on the canvas = two BlockNote editors bound to the same main-owned Y.Doc in the same renderer window. Yjs supports multiple bindings to one doc, but validate no echo/duplication (the `sourceWindowId` tagging prevents cross-window loops, not necessarily two in-window editors) — test explicitly.

### 7.2 Live title/status + dangling refs (no new primitive needed)

Reuse existing one-way IPC events (the tab context already does exactly this via `updateTabTitleByEntityId` / `setTabDeleted`):

- **note** → `onNoteUpdated` (`event.changes.title` — no refetch) + `onNoteDeleted`. Body edits go through the Y.Doc / `yjs-ipc-provider`, not `notes:updated`; **title-only cards are fine**.
- **task** → `onTaskUpdated` (`event.task` full payload) + `onTaskDeleted`; also check `archivedAt` (soft-delete) — treat archived as "gone".
- **calendar_event** → `onCalendarChanged` is fat-free (`{entityType,id}` only) → filter `entityType==='calendar_event' && id===cardId` then **refetch** `calendar.getEvent(id)`.

Build one small hook (mirror `useNote`) keyed by the set of `entityId`s on the canvas → per-id `{title, status, dangling}` map the cards render. **Dangling detection:** `get(id) === null` (or `archivedAt` set) on mount, flipped live by the delete/changed events. Also prune the advisory `canvas_entity_refs` row on delete.

### 7.3 Item capture & drag-drop

- **Drag from sidebar:** the live notes tree drags with **`text/plain` = bare note id** (or `folder-<path>`); there is **no** `MEMRY_NOTE_DRAG_MIME` on this branch (that lived on an unpushed branch). The only custom MIME in the repo is `application/x-memry-tree-node`. For canvas we need entityType too → **introduce a richer MIME** `application/x-memry-canvas-item` = `JSON.stringify({entityType, entityId})` set alongside `text/plain` at each drag source. **Tasks use @dnd-kit (not native dataTransfer)** — dragging a task to canvas needs a separate bridge or a "add task to canvas" action; do not promise task-drag via the note-tree path.
- **Drop handler** on the Excalidraw wrapper: `e.preventDefault()` in **both** `onDragOver` and `onDrop`; gate on the presence of your custom type (not `dataTransfer.files`, which is OS file-drop / import); compute `x = e.clientX - rect.left, y = e.clientY - rect.top` then convert to scene coords; create a rectangle with `customData`.
- **Capture-first new note on canvas:** `window.api.notes.create({ title })` (folder omitted → vault root; returns `note.id` synchronously, or pre-generate a 12-char id and pass `create({id, title})`). Store `{entityType:'note', entityId:res.note.id}`. Task capture needs a `projectId` (use the inbox project); event capture needs `startAt` — neither has a zero-arg blank capture like notes.
- **Open on double-click (DECIDED — reuse existing `tab.viewState` deep-links; no new tab kinds).** All three open "as if the item was clicked in its home view", using the proven mechanism from `agent-chat/messages/memry-links.tsx`:
  - **note** → `openTab({ type:'note', title, icon:'file-text', path:'/notes/'+id, entityId:id, ... })`.
  - **task** → `openTab({ type:'tasks', viewState:{ openTaskId: taskId, selectedType:'project', selectedId: projectId, selectedProjectId: projectId } })`. `pages/tasks.tsx:191` reads `viewState.openTaskId` → `detailTaskId` → opens `TaskDetailDrawer` (line 1242); `viewState.selectedProjectId` filters the list to the project. Fetch `projectId` first via `tasks.get(taskId)`.
  - **calendar_event** → `openTab({ type:'calendar', viewState:{ focusCalendarEventId: eventId, focusDate: startISO, focusedAt: Date.now() } })`. `pages/calendar.tsx:222-357` reads `viewState.focusCalendarEventId`/`focusDate`, sets anchor date + view, and opens/focuses the matching event (`sourceType==='event' && sourceId===eventId`). Fetch `startAt` first via `calendar.getEvent(eventId)`.
  - This is existing plumbing — canvas only assembles the `viewState`; no drawer/dialog/tab-kind work needed. (Distinct from _dragging a task onto_ the canvas, which still needs the @dnd-kit bridge — §7.3 drag note.)

---

## 8. Linking

- **Bound arrows** between item cards via the skeleton API (`start:{id}`/`end:{id}`); the arrow re-routes when either box moves. Persisted inside the scene blob; no extra tables.
- **Do NOT reflect spatial arrows into Memry's links/backlinks graph in v1.** Rationale: the links graph is derived from note **content** (`[[wikilinks]]`), rebuilt into the index db; injecting spatial arrows would (a) require writing into note bodies or a parallel authoritative edge store, (b) be lossy/ambiguous (a spatial arrow ≠ a semantic link, has direction/label the graph can't hold), and (c) create a two-way-sync hazard between the canvas blob and note content. Keep spatial links **canvas-local**; revisit as a separate feature if users ask for "canvas arrows → backlinks".

---

## 9. Renderer shell integration

- **Tab kind:** add `'canvas'` to `TabType` (`contexts/tabs/types.ts`); **leave out** of `SINGLETON_TAB_TYPES` (entity-based, one tab per canvas, auto-deduped by `entityId`). Wire the exhaustive maps typecheck forces: `TAB_ICONS` + `getDefaultPath()` (`contexts/tabs/helpers.ts`), `TYPE_TO_ICON` (+ `ICON_COMPONENTS`) (`components/tabs/tab-icon.tsx`).
- **Render + lazy-load:** in `components/split-view/tab-content.tsx` add `const LazyCanvasPage = React.lazy(async () => ({ default: (await import('@/pages/canvas')).CanvasPage }))` + a `case 'canvas'`. `CanvasPage` lazy-imports Excalidraw **internally** (double lazy is fine) — Excalidraw is heavy and must stay out of the main chunk. Verify Excalidraw's fonts/workers bundle locally (Electron renderer, no CDN, CSP).
- **Sidebar section:** a `<SidebarSection id="canvases" label={...} actions={<create '+' button/>}>` in `app-sidebar.tsx` `mainContent` (copy the Collections section); a `SidebarCanvasList` (mirror `sidebar-bookmark-list.tsx`) whose rows `openTab(...)`.
- **Theme follow:** `const { resolvedTheme } = useTheme()` (next-themes); pass `theme={resolvedTheme === 'dark' ? 'dark' : 'light'}` to `<Excalidraw>`. Note **three** non-system themes exist (`light`/`dark`/`white`) — map anything `!== 'dark'` to light. Robust signal: `document.documentElement.classList.contains('dark')`.
- **Feature flag:** add `spatialCanvas: z.boolean()` to `FeaturesSettingsSchema` + `spatialCanvas: false` to `FEATURES_SETTINGS_DEFAULTS` (`packages/contracts/src/settings-schemas.ts`). Read via `useFeatureFlags().flags.spatialCanvas`. **Keep it OUT of `FEATURE_KEYS`** for the hidden phase (FEATURE_KEYS is dual-purpose: Settings UI toggle **and** `featureForTabType` gating). Promote to `FEATURE_KEYS` + i18n `features.items.spatialCanvas.*` only for the opt-in phase (contracts change → `pnpm ipc:generate`/`ipc:check`, settings compat note).

---

## 10. Cross-platform & input matrix

DOM-only React. **Electron now; iPad web/PWA + Expo WebView later; never native RN.**

| Surface               | Draw (mouse) | Draw (touch)            | Draw (pen/pressure)                                        | Palm rejection                                                                                            | Notes                                                                                                 |
| --------------------- | ------------ | ----------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Electron (desktop)    | ✅           | ✅ trackpad/touchscreen | ✅ if digitizer present (Chromium `PointerEvent.pressure`) | OS-dependent                                                                                              | Primary target. Pressure = perfect-freehand `pressures[]`; **runtime-verify** the field is populated. |
| iPad Safari / PWA     | ✅           | ✅                      | ✅ Apple Pencil via PointerEvents `pointerType:'pen'`      | ⚠ **limited** — Excalidraw has no first-class palm rejection; relies on browser/OS pointer classification | Verify on real hardware; touch-to-pan vs pen-to-draw needs testing.                                   |
| Expo WebView (mobile) | n/a          | ✅                      | ✅ (WebView passes native pointer)                         | ⚠ limited                                                                                                 | Canvas runs as the same web bundle inside a WebView, NOT native RN canvas.                            |

**Honesty flags:** Excalidraw palm rejection is not a first-class feature — do not promise flawless Apple-Pencil-with-resting-palm until verified on device. Pressure fidelity depends on the browser delivering `PointerEvent.pressure`; some touch inputs report a constant 0.5 (`simulatePressure` fallback).

---

## 11. a11y / RTL / i18n / reduced-motion

- **Memry chrome** (sidebar section, canvas page wrapper, card overlay) uses **logical Tailwind props** (`ms/me`, `ps/pe`, `start/end`, `text-start/end`, `border-s/e`, `rounded-s/e`) — enforced for new code. WCAG AA + `prefers-reduced-motion`.
- **Excalidraw's own DOM** (toolbar, menus, dialogs): its i18n comes from **its bundled translations** via `langCode` (map Memry's locale → the closest Excalidraw `languages` code; fall back to `defaultLang`). This is **independent of Memry's `i18n:check`** (which only gates Memry's own strings) — state this honestly; we do not translate Excalidraw's internal UI ourselves, and its RTL/reduced-motion behaviour is Excalidraw's, not ours.
- Logging: `createLogger('SpatialCanvas')` (main: `@main/lib/logger`; renderer: `@/lib/logger`). User-facing errors: `extractErrorMessage(err, 'Could not open canvas')` from `@/lib/ipc-error` (**renderer-only** — do not import in main; main uses `main/lib/errors.ts`).

---

## 12. Heptabase parity checklist

| Heptabase capability                                   | Excalidraw / plan                                                               | v1?                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------- |
| Infinite pan/zoom canvas                               | Excalidraw built-in                                                             | ✅ M1                           |
| Freehand ink (pen, pressure)                           | freedraw + perfect-freehand                                                     | ✅ M1 (pressure runtime-verify) |
| Text, shapes, colors, arrows                           | Excalidraw built-in                                                             | ✅ M1                           |
| Multi-select, align, group, undo/redo                  | Excalidraw built-in                                                             | ✅ M1                           |
| Cards from real notes                                  | rectangle + `customData` ref                                                    | ✅ M2                           |
| Capture-first new note on canvas                       | `notes.create` in place                                                         | ✅ M2                           |
| Live card title/status                                 | events + `get(id)`                                                              | ✅ M2                           |
| Task / event cards                                     | rect + ref; double-click → `viewState` deep-link (task drawer / calendar focus) | ✅ M2                           |
| Connect cards with arrows                              | bound arrows                                                                    | ✅ M3                           |
| Sync across devices (E2E)                              | `canvas` record type                                                            | ✅ M4                           |
| Images on canvas                                       | externalized `memry-file://`+R2                                                 | ✅ M5                           |
| Whiteboard-in-whiteboard / sections                    | Excalidraw **frames** (child-before-parent order)                               | ➖ later                        |
| Rich **editable** note/task/event card (in-place CRUD) | hybrid rectangle + overlay editor; active-on-double-click                       | ✅ M6 (core)                    |
| ↗ Redirect card → open item in new tab                 | `openTab` + `viewState` deep-link                                               | ✅ M2                           |
| Card tags / filter / search on canvas                  | via `canvas_entity_refs` JOINs                                                  | ➖ later                        |
| Backlinks from canvas arrows                           | intentionally **not** reflected v1                                              | ➖ deferred (§8)                |
| Real-time co-edit of a canvas                          | LWW + conflict-copy (not CRDT)                                                  | ➖ non-goal                     |

---

## 13. Roadmap (milestones with exit criteria)

Each task's verification is concrete and green-or-not.

**M0 — Foundations (no user-facing surface).**

- Feature flag `spatialCanvas` (default off); DB migration 0035 (`canvases` + `canvas_entity_refs`); `canvas-api` contracts + `CanvasChannels`; IPC scaffolding + generated files.
- _Exit:_ `pnpm typecheck`, `pnpm ipc:check`, `pnpm check:contracts`, `pnpm check:architecture` green; migration applies **idempotently** on a copy of a prod-shaped DB (run twice, no error, existing rows intact).

**M1 — Canvas surface MVP (local-only, no sync).**

- Tab kind + sidebar "Canvases" section + lazy Excalidraw mount + theme follow; canvas CRUD/list via IPC; scene blob persisted encrypted-at-rest in the data db; native drawing (mouse/touch/pen).
- _Exit:_ e2e opens a canvas, draws with `page.mouse.move(...,{steps:14})`, reloads, ink persists; Excalidraw bundle confirmed out of the main chunk.

**M2 — Item cards (rectangle + overlay read-only preview) + capture-first + redirect.**

- Hybrid card: Excalidraw `rectangle` (`customData`) + DOM overlay layer (transform-synced to `scrollX/scrollY/zoom`) rendering a **read-only rich preview** — notes in the A4-page look (title + cached-body render), tasks/events as status/title chips. Drag note from sidebar → card; create unfiled note on canvas; **↗ redirect button** opens the item in a tab (note→tab, task→Tasks+drawer via `viewState.openTaskId`+project filter, event→Calendar focus via `viewState.focusCalendarEventId` — §7.3); live title via `onNoteUpdated`/`onTaskUpdated`/`onCalendarChanged`; dangling on delete; viewport virtualization.
- _Exit:_ e2e drag+drop creates a referencing card (no content copied); overlay preview stays aligned during pan/zoom; ↗ opens the correct tab/drawer/focus; editing elsewhere updates the preview; deleting shows dangling.

**M3 — Linking.**

- Bound arrows between two cards (skeleton `start.id`/`end.id`).
- _Exit:_ e2e connects two cards, moving a card re-routes the arrow, reload persists the link.

**M4 — Sync (E2E) — the big one.**

- Full `canvas` record sync type (§5), **hand-built conflict-copy**, `manifest-check` canvas branch, `sync-telemetry` case, deterministic push debounce. Deploy sync-server first.
- _Exit:_ two-profile concurrent-edit test produces a **conflict copy** (two rows), **no ink lost**; offline→online sync round-trips; old-client tolerance test (a client without `canvas` handler does not corrupt its cursor / self-heals via manifest); `sync_skipped_unknown_type` counter wired.

**M5 — Asset externalization.**

- `memry-file://`+R2 externalization; **dereference/GC endpoint**; **deterministic-fileKey dedup**; multi-asset reference set; pre-push size guard with user-facing error.
- _Exit:_ paste image → syncs to device B → renders; delete image/canvas → `ref_count` decrements → orphan chunk reaped; identical image pasted twice dedups; oversized canvas surfaces a toast + telemetry (not a silent drop).

**M6 — In-place live editing (core, required before default-on).**

- Active-card model: double-click promotes ONE card to `pointer-events:auto` and mounts the full editor — **note** = BlockNote bound to the note Y.Doc via `yjs-ipc-provider` (embedded `ContentArea` / slimmer `<EmbeddedNoteEditor>`); **task** = inline `task-detail-drawer` fields; **event** = new inline event form (none reusable today). Click-away/Escape → back to idle preview + unmount editor. Validate the pan/draw-vs-edit pointer split (§15 R15) and the two-editors-one-Y.Doc case (§7.1 Yjs caveat).
- _Exit:_ e2e double-click a note card edits its body in place and persists (verify via `notes.get`) with the note tab reflecting it live; task/event in-place edits persist; a note open in a tab **and** active on canvas stays consistent (no echo/dupe); 200-card + heavy-ink canvas with one active editor pans/zooms acceptably; off-screen cards unmounted.

**M7 — Rollout.**

- Promote flag to `FEATURE_KEYS` (Settings > Features opt-in) + i18n; telemetry dashboards; docs (`apps/docs/src`, `pnpm docs:impact --strict`). Then default-on after a soak.
- _Exit:_ opt-in toggle works + persists; docs gate green; telemetry visible in Grafana/AE.

---

## 14. Test & coverage strategy

**Layers:** unit (node/jsdom via vitest projects), main-integration (node), E2E (Playwright + Electron, `*.e2e.ts`). Coverage is a **separate CI check** with a ratchet (`coverage-thresholds.json`: statements 85.8 / branches 73.6 / functions 85.5 / lines 87.9); `pnpm test` enforces locally, the `unit` CI job runs with `MEMRY_SKIP_COVERAGE_THRESHOLDS=1` and a distinct "Coverage thresholds" job enforces it.

**jsdom cannot test the canvas** (no layout, `getContext()`→null, `getBoundingClientRect()`→zeros, no rAF pixels, no pointer hit-testing). So: unit-test **logic only** (document-model serialize/deserialize, entity-ref serialization, flag gate, migration idempotency, crypto round-trip, sync handler + conflict-copy, negotiation/backward-compat, IPC wiring); push **all** real canvas interaction/geometry to E2E with `page.mouse.*({steps:N>=8})`. Keep canvas _glue_ small so untestable code doesn't drag the ratchet red.

### Edge-case test matrix

| #   | Case                                      | Layer                  | Assertion                                                                                                               |
| --- | ----------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | Dangling ref (referenced note deleted)    | e2e + renderer unit    | card flips to dangling on `notes:deleted`; `get(id)` null-checked; ref row pruned                                       |
| 2   | Item edited elsewhere → live card update  | e2e                    | `onNoteUpdated.changes.title` updates card with no refetch                                                              |
| 3   | Same note referenced by N cards           | renderer unit          | all N cards update from one event; no content duplicated in blob                                                        |
| 4   | Corrupted/partial snapshot on pull        | main-integration       | `decryptSingleItem` → `DecryptionFailure`; canvas loads **read-only**; **no re-push**; item quarantined/corrupt-tracked |
| 5   | Migration runs twice                      | main-integration       | `IF NOT EXISTS` → second run no-ops; existing rows intact; `_journal.json` idx unique                                   |
| 6   | Old client receives unknown `canvas` type | main-integration       | `apply()` → `'skipped'`, no crash; cursor self-heals via manifest (with §5.3 branch)                                    |
| 7   | Pen pressure + palm rejection             | manual/device          | pressure varies stroke width; resting palm doesn't draw (⚠ device-verify)                                               |
| 8   | Undo/redo                                 | e2e                    | `CaptureUpdateAction` history correct; card create/move/link undoable                                                   |
| 9   | Delete card ≠ delete item                 | e2e                    | removing the rectangle leaves the note/task/event intact (`get(id)` still returns it)                                   |
| 10  | 2-device concurrent canvas edit           | 2-profile e2e          | LWW picks one; **conflict copy** row created; no ink lost                                                               |
| 11  | Delete-vs-concurrent-edit                 | main-integration       | delete `'skipped'`; canvas may resurrect; `deletedAt` tombstone makes it visible                                        |
| 12  | Oversized canvas snapshot                 | main-integration       | pre-push guard surfaces error + telemetry; **not** a silent `markFailed`                                                |
| 13  | Image asset dedup + GC                    | main-integration       | identical image dedups; delete → `ref_count` decrement → orphan reaped                                                  |
| 14  | RTL / reduced-motion / AA                 | renderer unit + manual | Memry chrome logical props flip; reduced-motion honored; contrast AA                                                    |
| 15  | i18n boundary                             | manual                 | Excalidraw UI follows `langCode`; Memry chrome passes `i18n:check`                                                      |
| 16  | Large-canvas performance                  | e2e/manual             | 200 cards + heavy ink pan/zoom acceptable; overlay alignment holds                                                      |
| 17  | Offline create → online sync              | e2e                    | canvas created offline reaches device B after reconnect (via `seedUnclocked` + manifest)                                |
| 18  | In-place note edit on canvas              | e2e                    | double-click card → edit body → persists (`notes.get`); note tab reflects it live                                       |
| 19  | Same note in tab + active on canvas       | e2e                    | edits in one surface appear in the other; no echo/duplicate blocks (Yjs two-editor)                                     |
| 20  | Redirect button vs edit                   | e2e                    | ↗ opens correct tab/drawer/focus; double-click edits in place; the two don't cross-fire                                 |
| 21  | Overlay alignment + virtualization        | e2e/manual             | previews stay glued to rectangles during pan/zoom; off-screen cards unmounted; active editor pointer-events correct     |
| 22  | In-place task/event edit                  | e2e                    | task drawer fields + event form edit in place; persist via `tasks`/`calendar` IPC; live preview updates                 |

---

## 15. Risks & mitigations (from adversarial critique)

| #   | Risk                                                                                                       | Sev         | Mitigation                                                                                                                                                                             | Ref     |
| --- | ---------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| R1  | Missing `manifest-check` canvas branch → permanent outbound loss + global 30-min re-pull storm             | **blocker** | Add `getLocalSyncableItems()` canvas block (`clock IS NOT NULL`); test not-server-only                                                                                                 | §5.3    |
| R2  | Promised conflict-copy doesn't exist; generic merge = destructive LWW overwrite                            | **blocker** | Hand-build conflict-copy in `applyUpsert` merge branch (new row + push) before overwrite; test 2 rows                                                                                  | §5.4    |
| R3  | Old clients pull `canvas` pages & skip-advance cursor (no pull-side negotiation on branch)                 | **high**    | Land #754, or default-off flag + guaranteed manifest self-heal + `sync_skipped_unknown_type` counter                                                                                   | §5.3    |
| R4  | Oversized snapshot silently dropped (cap pre-compression)                                                  | **high**    | Externalize assets; measure compressed; user-facing error + telemetry                                                                                                                  | §5.6    |
| R5  | Externalized images never reclaimed from R2 (quota leak)                                                   | **high**    | Dereference/GC endpoint + client GC on save/delete                                                                                                                                     | §6      |
| R6  | No image dedup (random fileKey/attachmentId)                                                               | **high**    | Deterministic content-hash fileKey OR on-disk content-hash dedup                                                                                                                       | §6      |
| R7  | Whole-doc LWW unmergeable → two full canvases                                                              | med         | Debounced push + push-on-blur; label conflict copies in sidebar; document                                                                                                              | §5.4    |
| R8  | Migration 0035 number collides with in-flight branches                                                     | med         | First-to-merge keeps 0035; others renumber + bump journal; never renumber a shipped migration                                                                                          | §3.2    |
| R9  | Non-idempotent migration bricks vault open                                                                 | med         | `CREATE ... IF NOT EXISTS`, additive-only, freeze after ship, no `db:generate`                                                                                                         | §3.2    |
| R10 | Orphan `canvas_entity_refs` on cross-device note delete                                                    | med         | Store ref only (no title snapshot); LEFT JOIN + null-check; prune on delete events                                                                                                     | §3.1 §6 |
| R11 | Bespoke decrypt/repair path bypasses quarantine                                                            | med         | Route strictly through `getHandler` registry; read-only on `DecryptionFailure`                                                                                                         | §5.5    |
| R12 | `attachmentReferences` single-element overwrite blocks GC                                                  | med         | N-asset reference set keyed by `canvasId`                                                                                                                                              | §6      |
| R13 | Deleted canvas resurrects after concurrent edit                                                            | low         | `deletedAt` tombstone; document delete-loses-to-edit                                                                                                                                   | §5.4    |
| R14 | Palm rejection / pressure fidelity weaker than promised                                                    | —           | Device-verify; do not over-promise Apple-Pencil UX until tested                                                                                                                        | §10     |
| R15 | Overlay pointer model: pan/draw vs in-place edit conflict (canvas eats card clicks or card eats pan)       | **high**    | Overlay `pointer-events:none` except the active card; card move/resize driven by the underlying rectangle (not the overlay); spike + e2e the double-click→active→click-away flow early | §7.1    |
| R16 | Per-card live editors don't scale (N BlockNote instances on an infinite canvas)                            | **high**    | Idle cards are read-only lightweight previews; only ONE active heavy editor; viewport-virtualize overlays; perf test at 200 cards                                                      | §7.1 M6 |
| R17 | Note editor (`ContentArea`) is page-coupled; two editors on one Y.Doc may echo                             | med         | Embedded layout mode or slimmer `<EmbeddedNoteEditor>`; explicitly test note-in-tab + note-active-on-canvas (no echo/dupe); reuse `yjs-ipc-provider`                                   | §7.1    |
| R18 | No reusable calendar-event edit form exists                                                                | med         | Build a small inline event form for the active event card; task reuses `task-detail-drawer`; note reuses BlockNote                                                                     | §7.1 M6 |
| R19 | `renderEmbeddable` path: arrow-binding to `embeddable` unverified + select-vs-interact gate blocks editing | med         | Do not adopt as primary; overlay is primary; only a timeboxed spike may promote it                                                                                                     | §7.1    |

---

## 16. Rollout, telemetry, backward-compat, rollback

- **Flag lifecycle:** hidden default-off (`schema`+`defaults` only) → opt-in (`FEATURE_KEYS` + Settings) → default-on after soak.
- **Deploy order:** sync-server first (adds `canvas` to the allowlist + `toSyncDomain` case + any telemetry enum), **then** desktop. Ideally after #754.
- **Telemetry (enum-only, AE + Grafana/Loki):** add events to `TelemetryEventNameSchema` (server deploys first or the **whole batch** is rejected). Candidates: `canvas_created`, `canvas_opened`, `canvas_sync_conflict_copy`, `canvas_too_large`, `sync_skipped_unknown_type`. Respect `SafeDimensionValueSchema` (≤64 chars, no `@`/`://`/slash, not UUID-shaped) via `toSafeToken`; no free-form message field.
- **Backward-compat checklist:** additive migration only, no DB reset; new sync type tolerated by old clients (push rejected, pull filtered/self-healed); settings blob merges the new default; IPC contracts additive; vault file formats unchanged (assets under `{vault}/attachments`).
- **Rollback:** flag off disables the surface instantly. Server keeps accepting `canvas` rows (harmless to older desktops that filter them). If a desktop build must be pulled, the data stays on the server; no schema rollback needed (tables are additive/inert when the flag is off).
- **Docs gate:** `pnpm docs:ai-update --base <base>` or manual `apps/docs/src`, then `pnpm docs:impact --base <base> --strict` + `pnpm docs:build`.

---

## 17. Open questions for Kaan

**Resolved:**

- ✅ **Sync gate ordering** → **land #754 first**; local-only M1–M3 proceed in parallel (§5.3).
- ✅ **Task/event card open UX** → **reuse existing `tab.viewState` deep-links** (task → Tasks page + project filter + `TaskDetailDrawer` via `openTaskId`; event → Calendar focus via `focusCalendarEventId`) — no new tab kinds (§7.3).

**Still open:**

1. **Task/event capture on canvas:** blank task needs a `projectId` (default to the inbox project?) and blank event needs a `startAt` (default to now?) — confirm defaults, or restrict capture-first to notes only in v1.
2. **Canvas title privacy:** plaintext `title` column (like the notes cache, simplest) vs `titleCiphertext` (fully E2E, matches `agent_conversations`)? Titles can leak into search/telemetry surfaces if plaintext.
3. **Image dedup approach:** convergent encryption (deterministic content-hash fileKey, standard known-plaintext tradeoff) vs on-disk content-hash dedup only? Affects privacy posture.
4. **`renderEmbeddable` spike:** before committing fully to the hybrid overlay, timebox a spike to confirm whether `renderEmbeddable` can host an interactive editor **and** keep arrows bound to the card — if it can, it's less overlay bookkeeping. Default plan is the overlay (§7.1); this only decides whether to try the cleaner path first. Who/when for the spike?
5. **Frames (whiteboard sections):** in scope for v1 or later? (Excalidraw supports frames natively but adds ordering constraints and card-in-frame semantics.)
6. **Migration number:** confirm which in-flight branch (`custom-themes` / `template-sync` / this) claims 0035 vs renumbers.

---

## 18. Branch re-validation addendum (2026-07-17, branch `claude/memry-spatial-canvas-*` @ 37f0c496f)

Re-validated by a 12-agent workflow (6 code validators + 2 context7 Excalidraw verifiers + 4 adversarial critics) against this branch. **All locked decisions hold.** The following corrections override the sections above where they conflict.

### M0 corrections

- **A1 (blocker).** `packages/contracts/src/feature-flags.test.ts` asserts FEATURE_KEYS ≡ defaults keys ("keeps FEATURE_KEYS aligned with the schema shape") and an exact 6-key `toEqual`. The hidden flag breaks both. Fix in M0: extend the defaults assertion with `spatialCanvas: false`; change alignment to `[...FEATURE_KEYS, ...HIDDEN_FEATURE_KEYS].sort()` with `HIDDEN_FEATURE_KEYS = ['spatialCanvas']`.
- **A2.** The generated invoke map inlines the `FeaturesSettings` shape (`generated-ipc-invoke-map.ts` getFeaturesSettings/setFeaturesSettings). The flag edit alone stales it → land the flag edit **before** the single `pnpm ipc:generate` run; commit both generated files with it.
- **A3.** Cut `upload-asset|get-asset|list-assets` from M0 CanvasChannels — every rpc method needs a live main handler or generated-rpc fails typecheck. Add them in M5 with their own regen. (The binary escape-hatch schema precedent lives app-side: `main/ipc/notes-schemas.ts`, not contracts.)
- **A4.** `check:architecture` forbids `main/ipc/*` importing `@main/database/queries/*` or `main/sync/**` → drizzle CRUD goes in **`main/canvas/store.ts`** (bookmarks `main/bookmarks/store.ts` precedent); `canvas-handlers.ts` imports only that + contracts + `./validate`. M4 note: canvas-sync gets added to `blockedFeatureSyncImports` and local-mutation enqueues live in the sync-layer registry, not the ipc layer.
- **A5 (replaces §3.2 verification).** Drizzle's migrator skips by journal `when` vs `__drizzle_migrations.created_at` and **never hash-verifies content** — "run migrations twice" is green-by-construction and proves nothing. Real M0 gates: (a) upgrade-path test — copy `drizzle-data/` to tmp, strip 0035 + last journal entry, `migrate(db, {migrationsFolder: tmpCopy})`, seed rows, then migrate with the full folder and assert `canvases`/`canvas_entity_refs` in `sqlite_master` + seeded rows intact; (b) raw double-execution of the 0035 statements (true IF NOT EXISTS idempotency); (c) `PRAGMA foreign_key_list(canvas_entity_refs)` shows ON DELETE CASCADE, composite-PK duplicate insert throws, both indexes exist. `when` MUST be > 1783206622572 (0034's) and **re-minted on any renumber** — a stale `when` silently skips the migration on updated installs (the real 0035-collision failure mode; `migrate-journal.test.ts` is the gate).
- **A6.** Editing shipped migration SQL **silently diverges** (no hash check) — freeze once ANY build applied it; post-ship fixes are a new migration. While iterating locally, wipe the dev profile or delete the last `__drizzle_migrations` row.
- **A7.** Register CanvasChannels in `ipc-channels.test.ts` `ALL_GROUPS` + `GROUP_PREFIXES` ('canvas:') or the duplicate/prefix guards ignore it. The `canvas-channels.ts` extraction contingency is dead weight (eslint max-lines counts effective lines; ~447/800) — dropped.
- **A8.** `packages/rpc/src/canvas.ts` must use **relative** `../../contracts/src/*.ts` imports (generator runs under strip-types); add `"./canvas"` to rpc `package.json` exports and `"./canvas-api"` to contracts exports; register in `rpcDomains` + `GeneratedRpcApi` (client key **and** Subscriptions extends).

### M1 corrections

- **B1.** Excalidraw `@excalidraw/excalidraw@0.18.1`, peer React `^17||^18.2||^19` — desktop React 19.2.3 OK. `import '@excalidraw/excalidraw/index.css'` is REQUIRED (0.18+ no auto-inject); parent container needs non-zero height.
- **B2.** Default font loading fetches from CDN at runtime — blocked by our CSP (`font-src 'self' data:`). Copy `dist/prod/fonts/` into renderer static assets and set `window.EXCALIDRAW_ASSET_PATH` via a `<script>` in index.html `<head>` (module-eval-time read; an effect inside lazy CanvasPage is a race). Worker subset is module-URL — `worker-src 'self' blob:` already covers it. No CSP change needed.
- **B3.** `serializeAsJSON(elements, appState, files, 'local')` is **positional, 4 required args** (the object-form doc example is wrong vs source). Pin v0.18 semantics.
- **B4.** e2e assertion mechanism: `page.evaluate(id => window.api.canvas.get(id))` → assert scene JSON element count/type (note-sync-helpers precedent). No canvas pixel assertions.
- **B5.** Debounced scene save must register with the save-registry (`use-flush-on-quit` handshake, PR #747 lesson) or the last debounce window of ink is lost on quit.
- **B6.** New TabType forces only `TAB_ICONS` + `TYPE_TO_ICON` (exhaustive Records); `getDefaultPath` has a default, `ICON_COMPONENTS` is string-keyed, `tab-content.tsx` switch has a default case (add the case manually — typecheck won't remind). Tab restore can't gate hidden-phase tabs → `CanvasPage` renders a flag-off placeholder when `!flags.spatialCanvas`.

### M2 corrections

- **C1.** onChange fires on **every pan/zoom state commit** (confirmed) → apply overlay transform **imperatively** (`overlayRef.current.style.transform`, `transform-origin: 0 0`, `appState.zoom.value`); zero setState during pan. Virtualization = padded-viewport membership with hysteresis behind rAF throttle; setState only on membership change. **200-card pan/zoom perf gate moves from M6 to M2.**
- **C2.** Idle preview = **static HTML rendered from markdown**, NOT read-only BlockNote (a read-only BlockNote is still a full ProseMirror instance; zoomed-out = all cards visible = R16 at M2). Lazy per-visible-card body fetch + small cache; refetch on visibility re-entry and active→idle; document that idle previews don't live-update body mid-edit (body edits ride the Y.Doc, not `notes:updated`).
- **C3.** Double-click on an idle card reaches Excalidraw (overlay is pointer-events:none) and opens its **bound-text editor** on the rectangle. Interception is OURS: capture-phase `dblclick` on the wrapper → `viewportCoordsToSceneCoords` → reverse-z hit-test `getSceneElements()` for `customData.entityId` (angle-aware) → `stopPropagation()` + activate. Also lock card rectangles against rotation (or make overlay angle-aware).
- **C4.** Pointer contract: click-away deactivates WITHOUT swallowing (one click deactivates and performs the canvas action — verify feel in spike); toolbar tool-select also deactivates; active-card container `stopPropagation()` on keydown/keyup (Escape closes editor and is swallowed; cmd+Z belongs to the editor while active).
- **C5.** e2e hooks: `data-canvas-card-id` + state attr on overlay cards; stamp `data-scroll-x/y/zoom` on the overlay container at each transform apply.
- **C6.** Existing deep-link precedent is `renderer/src/agent-chat/messages/memry-links.tsx` (task viewState = `{openTaskId}` only today; the enriched project-filter form needs `tasks.get` first, as §7.3 states). `MEMRY_NOTE_DRAG_MIME` **does exist on this branch** (virtualized-notes-tree sets it for non-markdown file drags only); canvas still adds `application/x-memry-canvas-item`.

### M4 corrections

- **D1 (blocker-fix detail).** `ApplyContext` is `{db, emit, vaultKey}` — no queue, no deviceId → the §5.4 conflict-copy "enqueue push" needs plumbing: extend ApplyContext/ItemApplier (engine.ts ~:80, apply-item.ts ~:29) to carry `queue` + `getDeviceId`, or import the canvas-sync service singleton in the handler. Enqueue-inside-apply-tx is verified SAFE (better-sqlite3 SAVEPOINT nesting; push kick gated during pull; `suppressPushDuringPull` concern is a non-issue).
- **D2.** Manifest branch must be `WHERE clock IS NOT NULL AND deleted_at IS NULL` (diverges from tasks template) and `seedUnclocked` must skip tombstones — the server manifest excludes tombstoned items (`services/sync.ts` deleted_at IS NULL) and a non-delete push NULLs server deleted_at → otherwise every soft-deleted canvas resurrects fleet-wide within 30 min.
- **D3.** `applyDelete` = soft tombstone modeled on **agent-conversation-handler** (the existing deletedAt precedent), NOT filter-handler's hard delete. Delete path (IPC + applyDelete) prunes `canvas_entity_refs` in the same tx (CASCADE is dead code under soft delete). Pull routes tombstones to applyDelete only (`dec.deletedAt ? 'delete'`), so payload `deletedAt` is push-metadata-only.
- **D4.** `applyUpsert` must **rebuild `canvas_entity_refs` from the incoming scene** in the same tx (else the advisory index is empty on every non-authoring device); the conflict-copy INSERT duplicates refs under the new id.
- **D5.** `CanvasSyncPayloadSchema` fields all-optional (repo forward-tolerance convention — parse failure = skip while cursor advances); validate scene presence at the use site.
- **D6.** Old-client tolerance test rewritten: matrix #6's "cursor self-heals via manifest" is impossible (old clients lack the branch). Real hazard = permanent 30-min full-re-pull loop for ALL released clients unless #754 filters `/sync/changes`, `/sync/pull` **and `/sync/manifest`** by negotiated types. **M4 entry gate: verify merged #754 filters all three.**
- **D7.** M4 exit adds: canvas created on an M1–M3 build (clock NULL) is seeded (`seedUnclocked` runs on every engine init) and reaches device B post-upgrade.
- **D8.** `pull-coordinator` PULL_APPLY_ORDER is non-exhaustive (default rank) — add an explicit canvas rank only if FK ordering ever matters.

### M6 corrections

- **E1.** A reusable controlled event form EXISTS: `components/calendar/calendar-event-popover.tsx` (`mode: 'create'|'edit'`, parent-owned draft state) — extract/reuse for the event card instead of building from scratch (R18 shrinks).
- **E2.** renderEmbeddable spike re-scoped: binding question is ANSWERED (runtime `isBindableElement` includes embeddable; the **skeleton API type-excludes it** — irrelevant for rectangle cards). Only remaining question: can `appState.activeEmbeddable` be driven programmatically past the center-third + 100ms gate. Half-day max, after M2, non-blocking; default = close R19, overlay stays primary.

### Crypto/at-rest note (M1)

Snapshot at-rest encryption mirrors agent-chat: `encryptAgentJsonForVault`-style XChaCha20 envelope under the vault key with a `canvas_snapshot` purpose AD (`main/agent/storage/encryption.ts` pattern; key via `getOrInitializeLocalVaultKey(db, getOrCreateVaultUuid(db))` — the latter lives in `main/agent/storage/vault-id.ts`). Store fns take `vaultKey` as a param (testable without keychain).

---

### Appendix — key file anchors (verified)

- Sync types: `packages/contracts/src/sync-api.ts` · handlers: `apps/desktop/src/main/sync/item-handlers/{index,types,base-handler,filter-handler,note-handler}.ts` · apply/pull: `apply-item.ts`, `engine/pull-coordinator.ts` · manifest: `sync/manifest-check.ts` · server: `apps/sync-server/src/services/sync.ts`, `services/sync-telemetry.ts`, `routes/sync.ts`.
- Crypto: `apps/desktop/src/main/sync/{encrypt,decrypt,decrypt-item,sync-crypto-batch}.ts` · `main/crypto/{encryption,signatures,keys,vault-key-state,index}.ts` · constants `packages/contracts/src/{crypto,cbor-ordering}.ts`.
- Assets: `main/sync/attachments.ts` · `main/vault/attachments.ts` · `main/lib/paths.ts` (`toMemryFileUrl`) · `main/index.ts` (`protocol.handle('memry-file', ...)`).
- DB: `packages/db-schema/src/{data-schema.ts,schema/agent-conversations.ts,schema/home-pages.ts}` · `apps/desktop/src/main/database/{migrate.ts,drizzle-data/,client.ts}` · `main/vault/{index.ts,indexer.ts}`.
- IPC: `packages/contracts/src/{ipc-channels,bookmarks-api}.ts` · `packages/rpc/src/{tasks,index}.ts` · `apps/desktop/scripts/{generate-rpc-bindings.ts,generate-ipc-invoke-map.js}` · `main/ipc/{index,bookmarks-handlers,validate}.ts` · `preload/{index.ts,api/bookmarks.ts}`.
- Renderer: `contexts/tabs/{types,helpers,context}.tsx` · `components/split-view/tab-content.tsx` · `components/{app-sidebar,sidebar-section,virtualized-notes-tree}.tsx` · `assets/base.css` · `hooks/{use-theme-sync,use-feature-flags}.ts`.
- Entities: `main/vault/notes-crud.ts` · `packages/domain-tasks/src/{commands,queries}.ts` · `main/ipc/calendar-handlers.ts` · `renderer/src/hooks/use-notes-query.ts` · `renderer/src/services/{notes,tasks,calendar}-service.ts`.
- Flags/telemetry/test: `packages/contracts/src/{settings-schemas,feature-flags,telemetry-api}.ts` · `main/telemetry/{track,diagnostics}.ts` · `renderer/src/lib/{telemetry,ipc-error,logger}.ts` · `config/{playwright.config.ts,vitest.config.ts,coverage-thresholds.json}` · `tests/e2e/utils/{electron-helpers,note-sync-helpers}.ts`, `tests/e2e/marquee-selection-block-types.e2e.ts`.
