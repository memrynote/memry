/**
 * Canvas IPC handlers (spatial canvas).
 * CRUD for encrypted canvas scene snapshots; hidden behind the spatialCanvas
 * feature flag in the renderer.
 *
 * @module ipc/canvas-handlers
 */

import { z } from 'zod'
import { ipcMain, BrowserWindow } from 'electron'
import {
  CanvasChannels,
  CanvasCreateSchema,
  CanvasUpdateSchema,
  CanvasGetAssetSchema,
  CanvasListAssetsSchema,
  CanvasLibrarySaveSchema,
  type CanvasLibraryListResponse,
  type CanvasLibrarySaveResponse,
  type CanvasCreatedEvent,
  type CanvasUpdatedEvent,
  type CanvasDeletedEvent,
  type CanvasTooLargeEvent,
  type CanvasUploadAssetResponse,
  type CanvasGetAssetResponse,
  type CanvasListAssetsResponse
} from '@memry/contracts/canvas-api'
import { createValidatedHandler, createHandler, createStringHandler } from './validate'
import { requireDatabase, type DataDb } from '../database'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import { getOrInitializeLocalVaultKey, secureCleanup } from '../crypto'
import { createCanvas, deleteCanvas, getCanvas, listCanvases, updateCanvas } from '../canvas/store'
import { listCanvasLibraryItems, saveCanvasLibraryItems } from '../canvas/library-store'
import { syncCanvasCreate, syncCanvasUpdate, syncCanvasDelete } from '../canvas/sync-bridge'
import {
  getCanvasAssetRef,
  injectSceneAssetSidecar,
  listCanvasAssetDescriptors,
  reconcileCanvasAssets,
  uploadCanvasAsset
} from '../canvas/assets/asset-service'
import { buildAssetServiceContext } from '../canvas/assets/asset-service-context'
import { trackMainEvent } from '../telemetry/track'

function emitCanvasEvent(
  channel: string,
  data: CanvasCreatedEvent | CanvasUpdatedEvent | CanvasDeletedEvent | CanvasTooLargeEvent
): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

// Resolved once per process, like agent bootstrap (main/agent/bootstrap.ts):
// getOrInitializeLocalVaultKey consults the OS keychain, and under
// NODE_ENV=test the keychain degrades to not-found (400ms timeout in
// crypto/keychain.ts) — so only the first call in a process can initialize;
// every later call would throw "verifier exists but master key is missing".
// A failed resolution is not cached so a transient keychain error can retry.
let vaultKeyPromise: Promise<Uint8Array> | null = null

// Binary payload validation is app-side, not contracts (A3): the renderer
// serializes ArrayBuffer to number[] over the invoke bridge, so accept both.
const UploadCanvasAssetSchema = z.object({
  canvasId: z.string().min(1),
  fileId: z.string().min(1),
  mimeType: z.string().min(1),
  data: z.instanceof(ArrayBuffer).or(z.array(z.number()))
})

function getVaultKeyOnce(db: DataDb, vaultId: string): Promise<Uint8Array> {
  if (!vaultKeyPromise) {
    vaultKeyPromise = getOrInitializeLocalVaultKey(db, vaultId).catch((error: unknown) => {
      vaultKeyPromise = null
      throw error
    })
  }
  return vaultKeyPromise
}

async function getCanvasContext(): Promise<{
  db: DataDb
  vaultId: string
  vaultKey: Uint8Array
}> {
  const db = requireDatabase()
  const vaultId = getOrCreateVaultUuid(db)
  const vaultKey = await getVaultKeyOnce(db, vaultId)
  return { db, vaultId, vaultKey }
}

export function registerCanvasHandlers(): void {
  // canvas:create - Create a new canvas (optionally with an initial scene)
  ipcMain.handle(
    CanvasChannels.invoke.CREATE,
    createValidatedHandler(CanvasCreateSchema, async (input) => {
      const { db, vaultId, vaultKey } = await getCanvasContext()
      const canvas = createCanvas(db, vaultKey, vaultId, input)
      trackMainEvent('canvas_created', {
        surface: 'canvas',
        action: 'created',
        objectType: 'canvas',
        result: 'success'
      })
      const { scene, ...summary } = canvas
      const synced = syncCanvasCreate(canvas.id, scene)
      emitCanvasEvent(CanvasChannels.events.CREATED, { canvas: summary })
      if (!synced) {
        // Created locally but too large to sync (§5.6) — surface, never silent.
        emitCanvasEvent(CanvasChannels.events.TOO_LARGE, { id: canvas.id })
      }
      return canvas
    })
  )

  // canvas:get - Fetch one canvas with its decrypted scene
  ipcMain.handle(
    CanvasChannels.invoke.GET,
    createStringHandler(async (id) => {
      const { db, vaultKey } = await getCanvasContext()
      const canvas = getCanvas(db, vaultKey, id)
      if (canvas) {
        // Fires per successful load, so a tab-switch remount counts again. That
        // is the intended meaning ("canvas loads"), documented in
        // apps/docs/src/architecture/observability.md — it is NOT distinct opens.
        trackMainEvent('canvas_opened', {
          surface: 'canvas',
          action: 'opened',
          objectType: 'canvas',
          result: 'success'
        })
      }
      return canvas
    })
  )

  // canvas:update - Update title/scene and rewrite advisory entity refs
  ipcMain.handle(
    CanvasChannels.invoke.UPDATE,
    createValidatedHandler(CanvasUpdateSchema, async (input) => {
      const { db, vaultKey } = await getCanvasContext()

      // Inject the memryAssets sidecar so the synced scene carries the asset
      // descriptors a receiving device needs to restore externalized images.
      const assetCtx = buildAssetServiceContext()
      const sceneToPersist =
        assetCtx && input.scene !== undefined
          ? injectSceneAssetSidecar(assetCtx, input.id, input.scene)
          : input.scene

      const summary = updateCanvas(db, vaultKey, input.id, { ...input, scene: sceneToPersist })
      if (!summary) {
        throw new Error('Canvas not found')
      }
      const synced = syncCanvasUpdate(input.id, sceneToPersist)
      emitCanvasEvent(CanvasChannels.events.UPDATED, { canvas: summary })
      if (!synced) {
        // Saved locally but too large to sync (§5.6) — surface, never silent.
        emitCanvasEvent(CanvasChannels.events.TOO_LARGE, { id: input.id })
      }

      // GC assets the saved scene no longer references (union protects assets
      // still used by other canvases).
      if (assetCtx && input.scene !== undefined) {
        await reconcileCanvasAssets(assetCtx, input.id, sceneToPersist ?? '')
      }
      return summary
    })
  )

  // canvas:delete - Soft-delete (tombstone) a canvas
  ipcMain.handle(
    CanvasChannels.invoke.DELETE,
    createStringHandler(async (id) => {
      const { db } = await getCanvasContext()

      // GC this canvas's assets before the row is tombstoned (the other-canvas
      // union keeps assets shared with surviving canvases). Reads the
      // canvas_assets rows, so it must run before soft-delete/sync-delete.
      const assetCtx = buildAssetServiceContext()
      if (assetCtx) {
        await reconcileCanvasAssets(assetCtx, id, '')
      }

      const success = deleteCanvas(db, id)
      if (success) {
        syncCanvasDelete(id)
        emitCanvasEvent(CanvasChannels.events.DELETED, { id })
      }
      return { success }
    })
  )

  // canvas:list - List canvas summaries for the current vault
  ipcMain.handle(
    CanvasChannels.invoke.LIST,
    createHandler(async () => {
      const { db, vaultId } = await getCanvasContext()
      return { canvases: listCanvases(db, vaultId) }
    })
  )

  // canvas:upload-asset - Externalize + dedup + upload one scene image
  ipcMain.handle(
    CanvasChannels.invoke.UPLOAD_ASSET,
    createValidatedHandler(
      UploadCanvasAssetSchema,
      async (input): Promise<CanvasUploadAssetResponse> => {
        const ctx = buildAssetServiceContext()
        if (!ctx) throw new Error('No vault is open')
        // The renderer sends ArrayBuffer as number[] over the invoke bridge.
        const bytes = new Uint8Array(input.data)
        return uploadCanvasAsset(ctx, input.canvasId, input.fileId, input.mimeType, bytes)
      }
    )
  )

  // canvas:get-asset - Resolve a scene image's memry-file:// ref
  ipcMain.handle(
    CanvasChannels.invoke.GET_ASSET,
    createValidatedHandler(CanvasGetAssetSchema, async (input): Promise<CanvasGetAssetResponse> => {
      const ctx = buildAssetServiceContext()
      if (!ctx) return { ref: null }
      return { ref: getCanvasAssetRef(ctx, input.canvasId, input.fileId) }
    })
  )

  // canvas:list-assets - List a canvas's externalized image descriptors
  ipcMain.handle(
    CanvasChannels.invoke.LIST_ASSETS,
    createValidatedHandler(
      CanvasListAssetsSchema,
      async (input): Promise<CanvasListAssetsResponse> => {
        const ctx = buildAssetServiceContext()
        if (!ctx) return { assets: [] }
        return { assets: listCanvasAssetDescriptors(ctx, input.canvasId) }
      }
    )
  )

  // canvas:library-list - The vault's Excalidraw library (shapes panel)
  ipcMain.handle(
    CanvasChannels.invoke.LIBRARY_LIST,
    createHandler(async (): Promise<CanvasLibraryListResponse> => {
      const { db, vaultId, vaultKey } = await getCanvasContext()
      return { libraryItems: listCanvasLibraryItems(db, vaultKey, vaultId) }
    })
  )

  // canvas:library-save - Reconcile the vault rows against Excalidraw's full
  // item list. Excalidraw's persistence adapter has no per-item callbacks, so
  // "absent from this payload" is how a delete reaches us.
  ipcMain.handle(
    CanvasChannels.invoke.LIBRARY_SAVE,
    createValidatedHandler(
      CanvasLibrarySaveSchema,
      async (input): Promise<CanvasLibrarySaveResponse> => {
        const { db, vaultId, vaultKey } = await getCanvasContext()
        return { changed: saveCanvasLibraryItems(db, vaultKey, vaultId, input.libraryItems) }
      }
    )
  )
}

export function unregisterCanvasHandlers(): void {
  ipcMain.removeHandler(CanvasChannels.invoke.CREATE)
  ipcMain.removeHandler(CanvasChannels.invoke.GET)
  ipcMain.removeHandler(CanvasChannels.invoke.UPDATE)
  ipcMain.removeHandler(CanvasChannels.invoke.DELETE)
  ipcMain.removeHandler(CanvasChannels.invoke.LIST)
  ipcMain.removeHandler(CanvasChannels.invoke.UPLOAD_ASSET)
  ipcMain.removeHandler(CanvasChannels.invoke.GET_ASSET)
  ipcMain.removeHandler(CanvasChannels.invoke.LIST_ASSETS)
  ipcMain.removeHandler(CanvasChannels.invoke.LIBRARY_LIST)
  ipcMain.removeHandler(CanvasChannels.invoke.LIBRARY_SAVE)
  if (vaultKeyPromise) {
    void vaultKeyPromise.then((key) => secureCleanup(key)).catch(() => {})
    vaultKeyPromise = null
  }
}
