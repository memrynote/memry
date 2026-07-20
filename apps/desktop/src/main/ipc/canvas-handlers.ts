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
import { syncCanvasCreate, syncCanvasUpdate, syncCanvasDelete } from '../canvas/sync-bridge'

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
      return getCanvas(db, vaultKey, id)
    })
  )

  // canvas:update - Update title/scene and rewrite advisory entity refs
  ipcMain.handle(
    CanvasChannels.invoke.UPDATE,
    createValidatedHandler(CanvasUpdateSchema, async (input) => {
      const { db, vaultKey } = await getCanvasContext()
      const summary = updateCanvas(db, vaultKey, input.id, input)
      if (!summary) {
        throw new Error('Canvas not found')
      }
      const synced = syncCanvasUpdate(input.id, input.scene)
      emitCanvasEvent(CanvasChannels.events.UPDATED, { canvas: summary })
      if (!synced) {
        // Saved locally but too large to sync (§5.6) — surface, never silent.
        emitCanvasEvent(CanvasChannels.events.TOO_LARGE, { id: input.id })
      }
      return summary
    })
  )

  // canvas:delete - Soft-delete (tombstone) a canvas
  ipcMain.handle(
    CanvasChannels.invoke.DELETE,
    createStringHandler(async (id) => {
      const { db } = await getCanvasContext()
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

  // canvas:upload-asset - Store a scene binary file (stub — see M5 Task 5)
  ipcMain.handle(
    CanvasChannels.invoke.UPLOAD_ASSET,
    createValidatedHandler(
      UploadCanvasAssetSchema,
      async (_input): Promise<CanvasUploadAssetResponse> => {
        throw new Error('canvas asset upload not implemented until M5 Task 5')
      }
    )
  )

  // canvas:get-asset - Resolve a scene binary file's ref (stub — see M5 Task 5)
  ipcMain.handle(
    CanvasChannels.invoke.GET_ASSET,
    createValidatedHandler(
      CanvasGetAssetSchema,
      async (_input): Promise<CanvasGetAssetResponse> => {
        throw new Error('canvas get-asset not implemented until M5 Task 5')
      }
    )
  )

  // canvas:list-assets - List a canvas's scene binary files (stub — see M5 Task 5)
  ipcMain.handle(
    CanvasChannels.invoke.LIST_ASSETS,
    createValidatedHandler(
      CanvasListAssetsSchema,
      async (_input): Promise<CanvasListAssetsResponse> => {
        throw new Error('canvas list-assets not implemented until M5 Task 5')
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
  if (vaultKeyPromise) {
    void vaultKeyPromise.then((key) => secureCleanup(key)).catch(() => {})
    vaultKeyPromise = null
  }
}
