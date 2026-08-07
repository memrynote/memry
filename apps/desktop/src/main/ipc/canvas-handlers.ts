/**
 * Canvas IPC handlers (spatial canvas).
 * CRUD for encrypted canvas scene snapshots; gated by the spatialCanvas
 * feature flag in the renderer.
 *
 * @module ipc/canvas-handlers
 */

import { z } from 'zod'
import { ipcMain, BrowserWindow, shell } from 'electron'
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
  type CanvasListAssetsResponse,
  type CanvasUpdateResponse
} from '@memry/contracts/canvas-api'
import { createValidatedHandler, createHandler, createStringHandler } from './validate'
import { getCanvasContext, disposeCanvasVaultKey } from '../canvas/vault-key'
import { forgetWindow, markCanvasClosed, markCanvasOpen } from '../canvas/live-registry'
import {
  createCanvas,
  deleteCanvas,
  duplicateCanvas,
  getCanvas,
  getCanvasFilePath,
  listCanvases,
  updateCanvas
} from '../canvas/store'
import { resolveCanvasFile } from '../canvas/scene-file'
import { readCanvasLibrary, writeCanvasLibrary } from '../canvas/library-file'
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
import { createLogger } from '../lib/logger'

const log = createLogger('CanvasIPC')

function emitCanvasEvent(
  channel: string,
  data: CanvasCreatedEvent | CanvasUpdatedEvent | CanvasDeletedEvent | CanvasTooLargeEvent
): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

/** Windows already carrying a 'closed' listener for live-canvas cleanup. */
const windowsHookedForClose = new Set<number>()

// Binary payload validation is app-side, not contracts (A3): the renderer
// serializes ArrayBuffer to number[] over the invoke bridge, so accept both.
const UploadCanvasAssetSchema = z.object({
  canvasId: z.string().min(1),
  fileId: z.string().min(1),
  mimeType: z.string().min(1),
  data: z.instanceof(ArrayBuffer).or(z.array(z.number()))
})

export function registerCanvasHandlers(): void {
  // canvas:create - Create a new canvas (optionally with an initial scene)
  ipcMain.handle(
    CanvasChannels.invoke.CREATE,
    createValidatedHandler(CanvasCreateSchema, async (input) => {
      const { db, vaultId, vaultPath } = getCanvasContext()
      const canvas = createCanvas(db, vaultPath, vaultId, input)
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
      const { db, vaultPath } = getCanvasContext()
      const canvas = getCanvas(db, vaultPath, id)
      if (canvas) {
        // Fires per successful load, so a tab-switch remount counts again. That
        // is the intended meaning ("canvas loads"), documented in
        // apps/docs/src/architecture/observability.md — it is NOT distinct opens.
        // An unreadable canvas (unmigrated legacy snapshot, or a file moved
        // outside the app) shows the dead-end screen instead of a canvas, so it
        // counts as a failed open, not a success.
        trackMainEvent('canvas_opened', {
          surface: 'canvas',
          action: 'opened',
          objectType: 'canvas',
          ...(canvas.unreadable
            ? { result: 'failed' as const, errorCode: 'canvas_unreadable' }
            : { result: 'success' as const })
        })
      }
      return canvas
    })
  )

  // canvas:update - Update title/scene and rewrite advisory entity refs
  ipcMain.handle(
    CanvasChannels.invoke.UPDATE,
    createValidatedHandler(CanvasUpdateSchema, async (input) => {
      const { db, vaultPath } = getCanvasContext()

      // Inject the memryAssets sidecar so the synced scene carries the asset
      // descriptors a receiving device needs to restore externalized images.
      const assetCtx = buildAssetServiceContext()
      const sceneToPersist =
        assetCtx && input.scene !== undefined
          ? injectSceneAssetSidecar(assetCtx, input.id, input.scene)
          : input.scene

      const result = updateCanvas(db, vaultPath, input.id, { ...input, scene: sceneToPersist })
      if (!result.ok) {
        throw new Error(
          result.reason === 'conflict'
            ? 'Canvas was modified by someone else since it was read'
            : 'Canvas not found'
        )
      }
      const summary = result.summary
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
      // tooLarge mirrors the TOO_LARGE event for callers with no subscription
      // (agent MCP writes); the event stays for the renderer's toast.
      return { ...summary, tooLarge: !synced } satisfies CanvasUpdateResponse
    })
  )

  // canvas:delete - Soft-delete (tombstone) a canvas
  ipcMain.handle(
    CanvasChannels.invoke.DELETE,
    createStringHandler(async (id) => {
      const { db, vaultPath } = getCanvasContext()

      // GC this canvas's assets before the row is tombstoned (the other-canvas
      // union keeps assets shared with surviving canvases). Reads the
      // canvas_assets rows, so it must run before soft-delete/sync-delete.
      const assetCtx = buildAssetServiceContext()
      if (assetCtx) {
        await reconcileCanvasAssets(assetCtx, id, '')
      }

      // The document goes to the OS trash, not straight to /dev/null: a canvas
      // is a real file in the user's vault, and a mis-click must be recoverable
      // from Finder/Explorer the way deleting the file by hand would be.
      const success = await deleteCanvas(db, vaultPath, id, (abs) => shell.trashItem(abs))
      if (success) {
        trackMainEvent('canvas_deleted', {
          surface: 'canvas',
          action: 'deleted',
          objectType: 'canvas',
          result: 'success'
        })
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
      const { db, vaultId } = getCanvasContext()
      return { canvases: listCanvases(db, vaultId) }
    })
  )

  // canvas:duplicate - Copy a canvas (scene + asset rows) beside the original
  ipcMain.handle(
    CanvasChannels.invoke.DUPLICATE,
    createStringHandler(async (id) => {
      const { db, vaultId, vaultPath } = getCanvasContext()
      const copy = duplicateCanvas(db, vaultPath, vaultId, id)
      // Null means the original is gone or its document could not be read. The
      // store already logged why; there is nothing to announce.
      if (!copy) return null
      const { scene, ...summary } = copy
      const synced = syncCanvasCreate(copy.id, scene)
      emitCanvasEvent(CanvasChannels.events.CREATED, { canvas: summary })
      if (!synced) {
        // Copied locally but too large to sync (§5.6) — surface, never silent.
        // Only the event, no `tooLarge` on the response: this mirrors
        // canvas:create, the handler duplicate is shaped like. The response
        // mirror exists on canvas:update for callers with no subscription
        // (agent MCP writes), and the agent surface has no canvas duplicate.
        emitCanvasEvent(CanvasChannels.events.TOO_LARGE, { id: copy.id })
      }
      return summary
    })
  )

  // canvas:reveal-in-finder - Show the canvas document in Finder/Explorer
  ipcMain.handle(
    CanvasChannels.invoke.REVEAL_IN_FINDER,
    createStringHandler(async (id) => {
      const { db, vaultPath } = getCanvasContext()
      const filePath = getCanvasFilePath(db, id)
      // A tombstoned canvas, or a pre-file legacy row, has no document to point
      // at. Returning quietly beats throwing: the renderer offers this action on
      // an unreadable canvas precisely so the user can go look for the file.
      if (!filePath) {
        log.warn('No canvas document to reveal', { id })
        return
      }
      shell.showItemInFolder(resolveCanvasFile(vaultPath, filePath))
    })
  )

  // canvas:open-external - Open the canvas document in the OS default app
  ipcMain.handle(
    CanvasChannels.invoke.OPEN_EXTERNAL,
    createStringHandler(async (id) => {
      const { db, vaultPath } = getCanvasContext()
      const filePath = getCanvasFilePath(db, id)
      if (!filePath) {
        log.warn('No canvas document to open externally', { id })
        return
      }
      await shell.openPath(resolveCanvasFile(vaultPath, filePath))
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
      const { vaultPath } = getCanvasContext()
      return { libraryItems: readCanvasLibrary(vaultPath) }
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
        const { vaultPath } = getCanvasContext()
        return {
          changed: writeCanvasLibrary(vaultPath, input.libraryItems) ? input.libraryItems.length : 0
        }
      }
    )
  )

  // Live-canvas ownership. Raw ipcMain.handle rather than a validate.ts helper
  // because the payload we actually care about is the SENDER's window id.
  ipcMain.handle(CanvasChannels.invoke.LIVE_OPENED, (event, canvasId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || typeof canvasId !== 'string' || !canvasId) return { ok: false }
    markCanvasOpen(canvasId, win.id)
    // One 'closed' listener per WINDOW, not per canvas open: a user switching
    // between canvases in the same window reports open on every mount, which
    // would otherwise stack a listener each time (and trip Electron's
    // max-listeners warning). The id is captured now because `win.id` is not
    // safe to read once the window is destroyed.
    const windowId = win.id
    if (!windowsHookedForClose.has(windowId)) {
      windowsHookedForClose.add(windowId)
      win.once('closed', () => {
        windowsHookedForClose.delete(windowId)
        forgetWindow(windowId)
      })
    }
    return { ok: true }
  })
  ipcMain.handle(CanvasChannels.invoke.LIVE_CLOSED, (event, canvasId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || typeof canvasId !== 'string' || !canvasId) return { ok: false }
    markCanvasClosed(canvasId, win.id)
    return { ok: true }
  })
}

export function unregisterCanvasHandlers(): void {
  ipcMain.removeHandler(CanvasChannels.invoke.CREATE)
  ipcMain.removeHandler(CanvasChannels.invoke.GET)
  ipcMain.removeHandler(CanvasChannels.invoke.UPDATE)
  ipcMain.removeHandler(CanvasChannels.invoke.DELETE)
  ipcMain.removeHandler(CanvasChannels.invoke.LIST)
  ipcMain.removeHandler(CanvasChannels.invoke.DUPLICATE)
  ipcMain.removeHandler(CanvasChannels.invoke.REVEAL_IN_FINDER)
  ipcMain.removeHandler(CanvasChannels.invoke.OPEN_EXTERNAL)
  ipcMain.removeHandler(CanvasChannels.invoke.UPLOAD_ASSET)
  ipcMain.removeHandler(CanvasChannels.invoke.GET_ASSET)
  ipcMain.removeHandler(CanvasChannels.invoke.LIST_ASSETS)
  ipcMain.removeHandler(CanvasChannels.invoke.LIBRARY_LIST)
  ipcMain.removeHandler(CanvasChannels.invoke.LIBRARY_SAVE)
  ipcMain.removeHandler(CanvasChannels.invoke.LIVE_OPENED)
  ipcMain.removeHandler(CanvasChannels.invoke.LIVE_CLOSED)
  windowsHookedForClose.clear()
  disposeCanvasVaultKey()
}
