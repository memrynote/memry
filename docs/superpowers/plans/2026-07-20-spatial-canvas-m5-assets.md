# Spatial Canvas M5 — Asset Externalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Also invoke `ipc-contract-change` for Task 3 (renderer↔main asset channels) and `superpowers:test-driven-development` for every logic task.

**Goal:** Externalize Excalidraw inline-base64 images out of the encrypted canvas scene JSON into `memry-file://` + R2 via the existing attachment pipeline, with a server dereference/GC endpoint, on-disk content-hash dedup, an N-asset reference set, and a refined size guard — additive, backward-compatible, flag default-OFF.

**Architecture:** Reuse the attachment/blob spine (`AttachmentSyncService` → `UploadQueue` → `attachmentEvents` → R2 chunks; `protocol.handle('memry-file')` for reads). New binary IPC channels `canvas:upload-asset|get-asset|list-assets`. A vault-level content-addressed on-disk store (`{vault}/attachments/canvas-assets/<contentHash>.<ext>`) gives a stable `memry-file://` ref + cheap dedup. A new `canvas_assets` table (migration 0036) is the per-device dedup index + GC bookkeeping; a `memryAssets` sidecar embedded in the synced scene JSON carries per-image `{attachmentId, contentHash, chunkHashes,…}` cross-device. A new sync-server endpoint `POST /sync/attachments/dereference {chunkHashes[]}` decrements `blob_chunks.ref_count` (client-supplied hashes — the server cannot map `attachmentId`→hashes); the existing cron `cleanupOrphanedBlobChunks` reaps at `ref_count<=0`.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), better-sqlite3 + Drizzle (data DB), libsodium (existing crypto — unchanged), Excalidraw 0.18.1, Hono + D1 + R2 (sync-server), Zod v4, Vitest, Playwright.

## Global Constraints

- **LIVE PRODUCTION BETA — backward compatibility MANDATORY.** No DB reset. Existing installs (incl. pre-M5 canvases with INLINE base64 scenes) must open, render, and sync with zero data loss. Externalization is additive; a pre-M5 canvas externalizes only on its next save.
- **Flag `spatialCanvas` stays default-OFF and hidden.** Do NOT touch its default, do NOT promote to `FEATURE_KEYS`. (`packages/contracts/src/settings-schemas.ts`.)
- **Do NOT change crypto primitives.** Option B = on-disk content-hash dedup only; keep the existing RANDOM per-image fileKey/attachmentId (server can never confirm a known image is present). NO convergent encryption.
- **Do NOT add a new `SyncItemType`.** Asset descriptors ride inside the existing `canvas` scene blob (`memryAssets` sidecar). Asset bytes ride the existing attachment chunk pipeline.
- **Deploy order (non-negotiable):** sync-server FIRST (dereference endpoint + telemetry enum additions), staging → verify → prod, THEN desktop. The dereference endpoint is a NEW route; a desktop that calls it before the server ships gets a 404 and must degrade gracefully (log + telemetry, never crash a save).
- **Never hand-concat `memry-file://`** (Windows drive-letter → 403). Always `toMemryFileUrl` (main) / `memryFileUrl` (renderer).
- **`markWritebackIgnored(diskPath)` BEFORE restoring a downloaded asset** or you get a re-upload loop.
- **Sync runs in a bundled worker** → worker-imported modules stay electron-free (`createLogger` from `@main/lib/logger` is fine; no `electron` import in shared logic). User-facing errors: `extractErrorMessage` (renderer only) / `main/lib/errors.ts` (main).
- **jsdom cannot test canvas geometry** → unit-test logic (externalize/dedup/ref-set/GC diff/sidecar/crypto round-trip/migration); push real image interaction to E2E.
- **Tailwind logical-props** for any new renderer UI (`ms/me`, `ps/pe`, `start/end`, …).
- **IPC regen order:** edit contracts → rpc → register main handlers → `pnpm ipc:generate` → `pnpm ipc:check`. Every new rpc method needs a live main handler or generated-rpc fails typecheck. Commit both generated files.
- **Migration:** hand-written SQL (Drizzle snapshots broken past 0021 — do NOT `db:generate`); additive `IF NOT EXISTS` only; append a `_journal.json` entry with a fresh `when` > `0035`'s; no `meta/0036_snapshot.json`; freeze once any build ships it.

---

## File Structure

**sync-server (Task 1 — ships first):**

- Modify `packages/contracts/src/blob-api.ts` — add `DereferenceRequestSchema`.
- Modify `apps/sync-server/src/routes/blob.ts` — add `POST /attachments/dereference` + a rate limiter; mirror the DELETE-session decrement loop.
- Modify `apps/sync-server/src/routes/blob.test.ts` + `src/__mocks__/blob-route-harness.ts` — teach the fake D1 the dereference lookup; assert per-hash decrement.
- Modify `packages/contracts/src/telemetry-api.ts` — add asset event-name literals (Task 8).

**Contracts + RPC (Task 2–3):**

- Modify `packages/contracts/src/ipc-channels.ts` — `CanvasChannels.invoke` += `UPLOAD_ASSET|GET_ASSET|LIST_ASSETS`.
- Modify `packages/contracts/src/canvas-api.ts` — asset request schemas + response types + `MemryAssetDescriptor`.
- Modify `packages/rpc/src/canvas.ts` — asset method bindings (`uploadAsset` via `implementation` escape hatch).
- Regenerate `apps/desktop/src/preload/generated-rpc.ts` + `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts` (committed).

**DB (Task 4):**

- Modify `packages/db-schema/src/schema/canvas.ts` — add `canvasAssets` table (auto-exported via `data-schema.ts` `export * from './schema/canvas.ts'` — verify).
- Create `apps/desktop/src/main/database/drizzle-data/0036_canvas_assets.sql` + append `meta/_journal.json`.

**Desktop asset logic (Task 5–6, pure + effectful split):**

- Create `apps/desktop/src/main/canvas/assets/content-hash.ts` — `hashAssetContent`, `assetFilename`, `extForMime`.
- Create `apps/desktop/src/main/canvas/assets/memry-assets.ts` — sidecar (de)serialize; ref extraction from scene.
- Create `apps/desktop/src/main/canvas/assets/dedup-plan.ts` — pure dedup/GC-diff logic.
- Create `apps/desktop/src/main/canvas/assets/asset-store.ts` — `canvas_assets` Drizzle CRUD.
- Create `apps/desktop/src/main/canvas/assets/asset-service.ts` — effectful orchestrator (disk write, upload enqueue, download restore, reconcile/GC) wiring the attachment spine.
- Create `apps/desktop/src/main/sync/attachment-dereference.ts` — `dereferenceChunks(chunkHashes[])` → POST; graceful 404.
- Modify `apps/desktop/src/main/ipc/canvas-handlers.ts` — register/teardown 3 asset handlers; call reconcile in UPDATE/DELETE.
- Modify `apps/desktop/src/main/canvas/store.ts` — `deleteCanvas` returns asset rows for GC; scene get/persist tolerate the sidecar.
- Modify the canvas sync apply handler (`apps/desktop/src/main/sync/item-handlers/canvas-handler.ts`) — on `applyUpsert`, ingest `memryAssets` (record rows + ensure-present download); conflict-copy duplicates rows; on `applyDelete`, GC.

**Size guard (Task 7):**

- Modify `apps/desktop/src/main/canvas/sync-bridge.ts` — refine `canvasSceneExceedsSyncCap` to measure compressed bytes; keep the single guard + toast + `canvas_too_large`.

**Renderer (Task 5 client half):**

- Modify `apps/desktop/src/renderer/src/pages/canvas/canvas-editor.tsx` + `canvas-persistence.ts` + `services/canvas-service.ts` — on save, upload new `data:` files via `canvas:upload-asset`, rewrite `files[fileId].dataURL` to the returned ref before `canvas:update`.

**Telemetry (Task 8):**

- Modify `packages/contracts/src/telemetry-api.ts` (shared; server validates → ships in Task 1's deploy).
- Emit via `trackMainEvent` in asset-service / sync-bridge.

---

## Interfaces (defined once, referenced by all tasks)

```ts
// packages/contracts/src/canvas-api.ts  (Task 2)
export interface MemryAssetDescriptor {
  fileId: string // Excalidraw file id (per scene)
  attachmentId: string // random id from AttachmentSyncService.uploadAttachment
  contentHash: string // plaintext sha256 hex (dedup key)
  chunkHashes: string[] // encryptedHash[] from UploadResult.manifest.chunks — for dereference
  mimeType: string
  sizeBytes: number
  filename: string // content-addressed on-disk filename
}
export const CanvasUploadAssetSchema = z.object({
  canvasId: z.string().min(1),
  fileId: z.string().min(1),
  mimeType: z.string().min(1),
  data: z.instanceof(ArrayBuffer).or(z.array(z.number())) // notes.uploadAttachment precedent
})
export interface CanvasUploadAssetResponse {
  ref: string
  descriptor: MemryAssetDescriptor
  deduped: boolean
}
export const CanvasGetAssetSchema = z.object({
  canvasId: z.string().min(1),
  fileId: z.string().min(1)
})
export interface CanvasGetAssetResponse {
  ref: string | null
}
export const CanvasListAssetsSchema = z.object({ canvasId: z.string().min(1) })
export interface CanvasListAssetsResponse {
  assets: MemryAssetDescriptor[]
}
```

```ts
// asset-store.ts row (Task 5)
export interface CanvasAssetRow {
  vaultId: string
  canvasId: string
  contentHash: string
  attachmentId: string
  fileId: string
  filename: string
  mimeType: string
  sizeBytes: number
  chunkHashes: string[]
  createdAt: number
}
```

```ts
// dedup-plan.ts pure API (Task 6)  — no I/O, fully unit-testable
export function planDereference(
  prevRows: CanvasAssetRow[], // canvas_assets WHERE canvasId = current
  currentContentHashes: Set<string>, // parsed from the just-saved scene refs
  otherCanvasHashes: Set<string> // canvas_assets WHERE canvasId != current (the GC union)
): { removedContentHashes: string[]; dereferenceChunkHashes: string[] }
```

```ts
// attachment-dereference.ts (Task 5)
export async function dereferenceChunks(
  chunkHashes: string[],
  deps: {
    getAccessToken(): Promise<string | null>
    getSyncServerUrl(): string
    getVaultId(): string
  }
): Promise<{ ok: boolean; status: number }> // graceful on 404 (server not yet deployed)
```

---

## Task 1: Sync-server dereference endpoint (ships first)

**Files:**

- Modify: `packages/contracts/src/blob-api.ts`
- Modify: `apps/sync-server/src/routes/blob.ts:57-85` (limiters), add route after `DELETE /attachments/upload/:session_id` (`:519`)
- Test: `apps/sync-server/src/routes/blob.test.ts`, `apps/sync-server/src/__mocks__/blob-route-harness.ts`

**Interfaces — Produces:** `POST /sync/attachments/dereference`, body `{ chunkHashes: string[] }`, decrements `blob_chunks.ref_count` by 1 per `(user_id, vault_id, hash)`; returns `{ dereferenced: number }`.

- [ ] **Step 1: Failing test — per-hash decrement.** In `blob.test.ts`, seed the fake D1 with two `blob_chunks` rows (`hash:'h1' ref_count:2`, `hash:'h2' ref_count:1`) for `user-1/vault-1`; `app.request('/attachments/dereference', {method:'POST', body: JSON.stringify({chunkHashes:['h1','h2']})}, env)`; assert 200, and via `findBinding(state, 'UPDATE blob_chunks SET ref_count = ref_count - 1')` that both hashes were decremented (h1→1, h2→0). Teach `blob-route-harness.ts` `createDb().first()` a branch matching `SELECT ... FROM blob_chunks WHERE user_id = ? AND vault_id = ? AND hash = ?` returning the seeded row.
- [ ] **Step 2: Run — FAIL** (`route not found`). `pnpm --filter @memry/sync-server test -- blob`.
- [ ] **Step 3: Contract schema.** In `blob-api.ts`:
  ```ts
  export const DereferenceRequestSchema = z.object({
    chunkHashes: z.array(z.string().min(1)).min(1).max(4096)
  })
  ```
- [ ] **Step 4: Route (mirror the cancel-session decrement, `blob.ts:483-500`).** Add a limiter like the existing ones, then:
  ```ts
  blob.post('/attachments/dereference', dereferenceLimit, async (c) => {
    const userId = c.get('userId')!
    const vaultId = c.get('vaultId')!
    const body: unknown = await c.req.json()
    const parsed = DereferenceRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Invalid dereference: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        400
      )
    }
    let dereferenced = 0
    for (const hash of new Set(parsed.data.chunkHashes)) {
      const chunk = await c.env.DB.prepare(
        'SELECT id, ref_count FROM blob_chunks WHERE user_id = ? AND vault_id = ? AND hash = ?'
      )
        .bind(userId, vaultId, hash)
        .first<{ id: string; ref_count: number }>()
      if (!chunk) continue
      await c.env.DB.prepare('UPDATE blob_chunks SET ref_count = ref_count - 1 WHERE id = ?')
        .bind(chunk.id)
        .run() // let cleanupOrphanedBlobChunks reap at ref_count<=0
      dereferenced++
    }
    return c.json({ dereferenced }, 200)
  })
  ```
  Do NOT eager-delete R2 here (unlike the session path) — the cron reap keeps this endpoint idempotent-ish and cheap. Decrement-only; never below the row's natural floor is fine (a stray double-call just makes cron reap it — acceptable and matches the session semantics; a hardening `ref_count = MAX(ref_count - 1, 0)` may be added if D1 supports it, else leave as-is to mirror the session loop).
- [ ] **Step 5: Run — PASS.** `pnpm --filter @memry/sync-server test -- blob`.
- [ ] **Step 6: Commit** `feat(sync-server): POST /attachments/dereference to decrement blob_chunks ref_count`.

**Verify (server suite):** `pnpm test:sync-server` green (90% coverage thresholds).

---

## Task 2: Contracts — asset channels + schemas

**Files:** Modify `packages/contracts/src/ipc-channels.ts:652-669`, `packages/contracts/src/canvas-api.ts`.

- [ ] **Step 1:** `CanvasChannels.invoke` += `UPLOAD_ASSET: 'canvas:upload-asset'`, `GET_ASSET: 'canvas:get-asset'`, `LIST_ASSETS: 'canvas:list-assets'` (keys SCREAMING_SNAKE_CASE, values `canvas:`-prefixed — `ipc-channels.test.ts` guards pass automatically since `CanvasChannels` is already in `ALL_GROUPS`).
- [ ] **Step 2:** Add the `MemryAssetDescriptor` + request schemas + response types from **Interfaces** above to `canvas-api.ts`. (No `package.json` exports change — `./canvas-api` subpath already registered from M0.)
- [ ] **Step 3:** `pnpm --filter @memry/contracts test` (channel guard) green.
- [ ] **Step 4: Commit.**

---

## Task 3: RPC bindings + regen (invoke `ipc-contract-change`)

**Files:** Modify `packages/rpc/src/canvas.ts:39-70`; regen writes `preload/generated-rpc.ts` + `main/ipc/generated-ipc-invoke-map.ts`.

**Interfaces — Consumes** Task 2 schemas; **Produces** `window.api.canvas.uploadAsset/getAsset/listAssets`.

- [ ] **Step 1:** Add three `defineMethod`s inside `methods:`. `getAsset`/`listAssets` are plain:
  ```ts
  getAsset: defineMethod<(canvasId: string, fileId: string) => Promise<CanvasGetAssetResponse>>({
    channel: CanvasChannels.invoke.GET_ASSET, params: ['canvasId', 'fileId']
  }),
  listAssets: defineMethod<(canvasId: string) => Promise<CanvasListAssetsResponse>>({
    channel: CanvasChannels.invoke.LIST_ASSETS, params: ['canvasId']
  }),
  ```
  `uploadAsset` uses the binary `implementation` escape-hatch (notes.ts:501-512 precedent — take a `Blob`/`ArrayBuffer`):
  ```ts
  uploadAsset: defineMethod<(input: { canvasId: string; fileId: string; mimeType: string; data: ArrayBuffer }) => Promise<CanvasUploadAssetResponse>>({
    channel: CanvasChannels.invoke.UPLOAD_ASSET, params: ['input'],
    implementation: `async (input) =>
      invoke(${JSON.stringify(CanvasChannels.invoke.UPLOAD_ASSET)}, {
        canvasId: input.canvasId, fileId: input.fileId, mimeType: input.mimeType,
        data: Array.from(new Uint8Array(input.data))
      })`
  }),
  ```
  Add the response types to the imports (relative `../../contracts/src/canvas-api.ts` — generator runs under strip-types; A8).
- [ ] **Step 2:** Register the app-side upload schema. The binary schema is app-side, not contracts (A3): add to `apps/desktop/src/main/ipc/canvas-handlers.ts` a local `UploadCanvasAssetSchema = z.object({ canvasId, fileId, mimeType, data: z.instanceof(ArrayBuffer).or(z.array(z.number())) })`.
- [ ] **Step 3:** Register the three `ipcMain.handle` handlers (Task 5 provides bodies) so the invoke-map generator sees them. **Handlers must exist before regen or `ipc:check` fails.** Implement stub handlers first (throw `not implemented`) to unblock regen, fill in Task 5.
- [ ] **Step 4:** `pnpm ipc:generate` then `pnpm ipc:check`. Commit BOTH generated files.
- [ ] **Step 5: Commit** `feat(canvas): asset IPC channels + rpc bindings (M5)`.

---

## Task 4: `canvas_assets` table + migration 0036

**Files:** Modify `packages/db-schema/src/schema/canvas.ts`; create `apps/desktop/src/main/database/drizzle-data/0036_canvas_assets.sql`; append `meta/_journal.json`.

- [ ] **Step 1:** Add to `canvas.ts` (mirror `canvases`/`canvasEntityRefs` style):
  ```ts
  export const canvasAssets = sqliteTable(
    'canvas_assets',
    {
      vaultId: text('vault_id').notNull(),
      canvasId: text('canvas_id').notNull(),
      contentHash: text('content_hash').notNull(),
      attachmentId: text('attachment_id').notNull(),
      fileId: text('file_id').notNull(),
      filename: text('filename').notNull(),
      mimeType: text('mime_type').notNull(),
      sizeBytes: integer('size_bytes').notNull(),
      chunkHashes: text('chunk_hashes', { mode: 'json' }).$type<string[]>().notNull(),
      createdAt: integer('created_at').notNull()
    },
    (t) => [
      primaryKey({ columns: [t.canvasId, t.contentHash] }),
      index('idx_canvas_assets_dedup').on(t.vaultId, t.contentHash),
      index('idx_canvas_assets_attachment').on(t.attachmentId),
      foreignKey({ columns: [t.canvasId], foreignColumns: [canvases.id] }).onDelete('cascade')
    ]
  )
  ```
  Note: FK cascade cleans rows on hard-delete, but canvas delete is SOFT (tombstone) — Task 5 GC prunes rows explicitly in the delete path; the FK is a safety net only.
- [ ] **Step 2:** Failing test `packages/db-schema` or `apps/desktop` migration test (real better-sqlite3 `:memory:`, load migration SQL, `PRAGMA table_info(canvas_assets)` asserts columns; `PRAGMA foreign_key_list` shows CASCADE; duplicate `(canvasId, contentHash)` insert throws; both indexes exist). Model on `schema/d1.test.ts` style + the M0 A5 upgrade-path test.
- [ ] **Step 3:** Write `0036_canvas_assets.sql` (hand-written comment; `CREATE TABLE IF NOT EXISTS canvas_assets (...)` → `--> statement-breakpoint` → two `CREATE INDEX IF NOT EXISTS`). Additive only.
- [ ] **Step 4:** Append `_journal.json`: `{"idx":36,"version":"6","when":<epoch_ms > 0034/0035's>,"tag":"0036_canvas_assets","breakpoints":true}`. Confirm `_journal.json` current max idx is 35 before writing. Do NOT create `meta/0036_snapshot.json`. Re-mint `when` if any in-flight branch claims 0036 first (A5 — stale `when` silently skips on updated installs).
- [ ] **Step 5:** Run migration test — PASS. Verify `canvasAssets` reachable from `@memry/db-schema` barrel (`data-schema.ts` `export *`).
- [ ] **Step 6: Commit** `feat(canvas): canvas_assets table + migration 0036 (M5 dedup/GC index)`.

---

## Task 5: Asset service — externalize, dedup, upload, restore, GC (effectful)

**Files:** Create `content-hash.ts`, `memry-assets.ts`, `asset-store.ts`, `asset-service.ts`, `sync/attachment-dereference.ts`; wire `canvas-handlers.ts`.

**Interfaces — Consumes:** `AttachmentSyncService.uploadAttachment/downloadAttachment` + `UploadQueue` (bound via the same lazy-singleton wiring as `sync-attachment-handlers.ts:86-132`), `attachmentEvents`, `markWritebackIgnored`, `toMemryFileUrl`, `getVault…Dir`. **Produces:** the three IPC handler bodies + `reconcileCanvasAssets(canvasId, scene)`.

### 5a — content-hash + sidecar (pure, electron-free)

- [ ] `content-hash.ts`: `hashAssetContent(bytes: Uint8Array): string` = `sodium.to_hex(sodium.crypto_hash_sha256(bytes))` (reuse `sha256Hex` pattern from attachments.ts; sha256 is collision-safe for content addressing). `extForMime(mime): string` (`image/png`→`png`, jpeg→`jpg`, gif, webp, svg+xml→`svg`; default `bin`). `assetFilename(contentHash, mime) = \`${contentHash}.${extForMime(mime)}\``. **Tests:** deterministic hash for same bytes; different bytes → different hash; ext mapping.
- [ ] `memry-assets.ts`:
  - `extractSceneFileRefs(sceneJson: string): { fileId: string; ref: string }[]` — parse `files`, return entries whose `dataURL` is a `memry-file://` ref (skip `data:` ones).
  - `contentHashFromRef(ref: string): string | null` — parse the content-addressed filename out of a `memry-file://…/canvas-assets/<hash>.<ext>` ref (via `fromMemryFileUrl` + basename).
  - `readMemryAssets(sceneJson): MemryAssetDescriptor[]` — top-level `memryAssets` key (`[]` if absent → backward compat with pre-M5/base64 scenes).
  - `writeMemryAssets(sceneJson, descriptors): string` — parse → set `memryAssets` → stringify (deterministic key order not required).
  - **Tests:** round-trip write→read; a pre-M5 scene (no key, base64 files) → `readMemryAssets` = `[]` and `extractSceneFileRefs` = `[]` (proves backward compat); ref→contentHash parse incl. a Windows-style path.

### 5b — asset-store (Drizzle CRUD)

- [ ] `asset-store.ts`: `findByContentHash(db, vaultId, contentHash): CanvasAssetRow | undefined`; `recordAsset(db, row)` (upsert on `(canvasId, contentHash)`, `null`-coalesce per Drizzle gotcha); `listByCanvas(db, canvasId)`; `hashesReferencedByOtherCanvases(db, vaultId, canvasId): Set<string>` (the GC union — `SELECT DISTINCT content_hash … WHERE vault_id=? AND canvas_id != ?`); `deleteCanvasAssetRows(db, canvasId, contentHashes[])`. **Tests:** in-memory DB — dedup lookup hits across canvases; union excludes the current canvas; delete removes only the named rows.

### 5c — dereference client

- [ ] `sync/attachment-dereference.ts`: `dereferenceChunks(chunkHashes, deps)` POSTs `/sync/attachments/dereference` with `Authorization` + `X-Memry-Vault-Id`. **On 404 (server not yet deployed) or network error: log `warn`, return `{ok:false}` — NEVER throw into a canvas save.** **Test:** 200 path calls fetch with the hashes; 404 returns `{ok:false}` without throwing (mirror the `http-client` test style; lazy URL resolution per the known gotcha).

### 5d — asset-service (orchestrator)

- [ ] `uploadCanvasAsset(canvasId, fileId, mimeType, bytes)`:
  1. `contentHash = hashAssetContent(bytes)`.
  2. Dedup: `existing = findByContentHash(db, vaultId, contentHash)`. If found → write the file to disk **only if missing** (idempotent), `recordAsset` a row for THIS canvasId reusing `existing.attachmentId/filename/chunkHashes`, emit `canvas_asset_dedup_hit`, return `{ ref: toMemryFileUrl(diskPath), descriptor, deduped:true }`. **No upload.**
  3. New: `diskPath = {vault}/attachments/canvas-assets/<assetFilename>`; `mkdir -p`; `markWritebackIgnored(diskPath)`; `atomicWriteBinary(diskPath, bytes)`. `uploadAttachment(canvasId, diskPath)` via the queue → `UploadResult` (attachmentId, manifest.chunks). `chunkHashes = manifest.chunks.map(c => c.encryptedHash)`. `recordAsset(...)`. Emit `canvas_asset_uploaded` (`metrics.byteCount`). Return `{ ref, descriptor, deduped:false }`.
  - Reuse the `getOrCreateAttachmentService`/`uploadQueue` singletons from `sync-attachment-handlers.ts` (export them or replicate the wiring; prefer exporting a shared accessor to avoid two queues).
- [ ] `ensureAssetsPresent(canvasId, descriptors)` (device B restore): for each descriptor whose `diskPath` is missing → `markWritebackIgnored(diskPath)` FIRST → `downloadAttachment(attachmentId, diskPath)` → `recordAsset` locally. Missing-file protocol handler already returns a transparent PNG until this completes.
- [ ] `reconcileCanvasAssets(canvasId, sceneJson)` (GC on save/delete): `current = new Set(extractSceneFileRefs(scene).map(r => contentHashFromRef(r.ref)))`; `prev = listByCanvas(db, canvasId)`; `others = hashesReferencedByOtherCanvases(db, vaultId, canvasId)`; `{removedContentHashes, dereferenceChunkHashes} = planDereference(prev, current, others)` (Task 6). `deleteCanvasAssetRows(db, canvasId, removedContentHashes)`; if `dereferenceChunkHashes.length` → `dereferenceChunks(...)` (fire-and-forget, graceful) + emit `canvas_asset_gc_reaped` (`metrics.itemCount`). Optionally unlink the disk file only when the hash is in NO canvas (i.e. also not in `others`) — safe because GC ran the union.

### 5e — IPC handlers

- [ ] Fill the Task 3 stubs in `canvas-handlers.ts`: `UPLOAD_ASSET` → `Buffer.from(new Uint8Array(input.data))` → `uploadCanvasAsset`; `GET_ASSET`/`LIST_ASSETS` → `asset-store` reads. Teardown in `unregisterCanvasHandlers`.
- [ ] In the `UPDATE` handler (after `updateCanvas`, before/after sync): inject the `memryAssets` sidecar into the stored scene (`writeMemryAssets` from `listByCanvas`) so the SYNCED payload carries descriptors, then `reconcileCanvasAssets`. In the `DELETE` handler: `reconcileCanvasAssets(canvasId, '')` (empty scene → all hashes removed → GC union protects shared ones) then soft-delete.
  - **Architecture guard (A4):** `canvas-handlers.ts` must not import `@main/database/queries/*` or `main/sync/**` directly. Put all Drizzle + attachment wiring in `main/canvas/assets/*` (store precedent); the handler imports only `main/canvas/*` + contracts + `./validate`. Run `pnpm check:architecture`.

- [ ] **Commit** `feat(canvas): externalize/dedup/restore/GC asset service + IPC handlers (M5)`.

---

## Task 6: Pure dedup/ref-set/GC-diff logic (TDD-first)

**Files:** Create `apps/desktop/src/main/canvas/assets/dedup-plan.ts` + `dedup-plan.test.ts`.

- [ ] **Step 1: Failing tests** for `planDereference(prevRows, currentContentHashes, otherCanvasHashes)`:
  - image removed from scene AND not referenced elsewhere → its chunkHashes returned for dereference; its contentHash in `removedContentHashes`.
  - image removed from scene BUT still in `otherCanvasHashes` (conflict-copy / shared) → NOT dereferenced; still removed from THIS canvas's rows.
  - image still present → no dereference.
  - unchanged scene → empty plan.
- [ ] **Step 2: FAIL.** **Step 3:** implement (set difference: `removed = prev.filter(r => !current.has(r.contentHash))`; `dereferenceChunkHashes = removed.filter(r => !other.has(r.contentHash)).flatMap(r => r.chunkHashes)`). **Step 4: PASS.** **Step 5: Commit.**

---

## Task 7: Size-guard refinement (do NOT duplicate)

**Files:** Modify `apps/desktop/src/main/canvas/sync-bridge.ts:34`.

- [ ] Keep the single guard. Once images externalize, the scene rarely trips it; verify it still fires for huge freehand-ink scenes. Refine `canvasSceneExceedsSyncCap` to measure the **compressed** payload (spec §5.6) IF `compressPayload` is importable electron-free here; else keep raw-byte measurement with a note. Test: a >3MB freehand scene (no images) still returns `true` → toast + `canvas_too_large` telemetry (assert `trackMainEvent` called), NOT a silent `markFailed`. Do not add a second cap.
- [ ] **Commit.**

---

## Task 8: Telemetry enum (ships with Task 1's server deploy)

**Files:** Modify `packages/contracts/src/telemetry-api.ts:3-51`.

- [ ] Add literals to `TelemetryEventNameSchema`: `'canvas_asset_uploaded'`, `'canvas_asset_dedup_hit'`, `'canvas_asset_gc_reaped'`. Use `surface:'sync'`, `action` ∈ safe tokens (`'asset_upload'`/`'asset_dedup'`/`'asset_gc'`), `objectType:'canvas'`, only `metrics` (byteCount/itemCount) — **never** put `attachmentId`/`contentHash` in a dimension (`SafeDimensionValueSchema`: no slash, not UUID-shaped, ≤64). **These are validated server-side → they must be in the sync-server build that deploys FIRST.**
- [ ] `pnpm --filter @memry/contracts test` + `pnpm --filter @memry/sync-server test` green. **Commit** (fold into Task 1's PR-of-record ordering).

---

## Task 9: Sync apply integration (device B) + conflict-copy

**Files:** Modify `apps/desktop/src/main/sync/item-handlers/canvas-handler.ts`.

- [ ] `applyUpsert`: after writing the row, `readMemryAssets(scene)` → `recordAsset` each locally (device B now has the dedup index) → `ensureAssetsPresent(canvasId, descriptors)` (download, `markWritebackIgnored` first). The **conflict-copy** INSERT (M4 `resolution.action==='merge'`) copies the same scene → its `memryAssets` → `recordAsset` under the NEW canvasId (shared attachmentIds) so the GC union protects them. Keep it inside the same `ctx.db.transaction`; download is fire-and-forget after commit (not inside the tx).
- [ ] `applyDelete` (soft tombstone): `reconcileCanvasAssets(canvasId, '')` — GC union prevents reaping assets a live conflict-copy still holds.
- [ ] **Tests (main-integration, node):** (1) applyUpsert of a scene with 2 memryAssets records 2 rows + triggers 2 downloads (mock the service); (2) a conflict-copy apply leaves the shared assets referenced by BOTH canvasIds → planDereference over either returns empty; (3) a pre-M5 base64 scene (no memryAssets) applies with zero asset rows + zero downloads (backward compat).
- [ ] **Commit.**

---

## Verification (exit criteria — all green)

- [ ] `pnpm typecheck && pnpm lint && pnpm ipc:check && pnpm i18n:check && pnpm check:architecture && pnpm check:contracts` (run `pnpm ipc:generate` before `ipc:check`).
- [ ] `pnpm test:sync-server` (dereference route + coverage 90%).
- [ ] `pnpm test:desktop` (content-hash, sidecar, asset-store, dedup-plan, dereference-client, sync-apply integration) + coverage ratchet green (keep glue thin so it doesn't drag the ratchet).
- [ ] `git diff --check`.
- [ ] E2E (`SYNC_SERVER_URL=https://sync-staging.memrynote.com`, build first): paste image on A → renders; syncs to B → renders via `memry-file://` restore; delete image then delete canvas on A → server `ref_count` decrements → orphan reaped by `cleanupOrphanedBlobChunks`; paste same image twice → one R2 object / stable ref (no second upload); oversized freehand canvas → toast + telemetry; pre-M5 inline-base64 canvas opens + externalizes on next save; conflict-copy asset test → GC does not reap shared assets.
- [ ] `pnpm docs:ai-update --base origin/main` (or manual `apps/docs/src`) → `pnpm docs:impact --base origin/main --strict` + `pnpm docs:build`.
- [ ] Manual 2-device asset smoke.

## Deploy (mandatory order — the one step NOT done autonomously)

1. Merge/deploy **sync-server** (dereference endpoint + telemetry enum) via GitHub Actions → **staging** → verify `POST /sync/attachments/dereference` + `cleanupOrphanedBlobChunks` reap → **prod**.
2. THEN release **desktop**. Confirm M4 sync-server is already live in prod before shipping M5 (entry gate).

---

## Self-Review

- **Spec coverage:** §6 gap1 (GC) → Task 1+5d+6+9; gap2 (dedup) → Task 5d(2)+6; gap3/R12 (N-asset set) → Task 4+5b+9. §5.6/R4 size guard → Task 7. §13 M5 exit criteria → Verification. §18 A3 (channels deferred to M5) → Task 2/3. §17 Q3 dedup=Option B → honored (random keys, on-disk hash). Appendix asset anchors → all re-verified.
- **Backward compat:** pre-M5 base64 scene tested at 5a, 9 (zero asset rows/downloads); no DB reset; additive migration; graceful 404 on the new endpoint; flag stays off.
- **Type consistency:** `MemryAssetDescriptor` / `CanvasAssetRow` / `chunkHashes` (encryptedHash[]) used identically across Tasks 2/4/5/9. `planDereference` signature matches its call site in 5d.
- **Deploy safety:** telemetry enum + endpoint both in the server-first build; desktop degrades if endpoint absent.
- **Open contingency (flagged, not blocking):** if Excalidraw refuses a non-`data:` `dataURL`, switch to re-hydrate-on-`canvas:get` (main reads disk → base64 into `files`); storage/sync externalization is unaffected. Validate in the first E2E paste test.
