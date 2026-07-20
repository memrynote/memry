/**
 * Canvas IPC handlers (spatial canvas).
 * CRUD for encrypted canvas scene snapshots; hidden behind the spatialCanvas
 * feature flag in the renderer.
 *
 * @module ipc/canvas-handlers
 */

import { ipcMain, BrowserWindow } from 'electron'
import {
  CanvasChannels,
  CanvasCreateSchema,
  CanvasUpdateSchema,
  type CanvasCreatedEvent,
  type CanvasUpdatedEvent,
  type CanvasDeletedEvent
} from '@memry/contracts/canvas-api'
import { createValidatedHandler, createHandler, createStringHandler } from './validate'
import { requireDatabase, type DataDb } from '../database'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import { getOrInitializeLocalVaultKey, secureCleanup } from '../crypto'
import { createCanvas, deleteCanvas, getCanvas, listCanvases, updateCanvas } from '../canvas/store'

function emitCanvasEvent(
  channel: string,
  data: CanvasCreatedEvent | CanvasUpdatedEvent | CanvasDeletedEvent
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
      const { scene: _scene, ...summary } = canvas
      emitCanvasEvent(CanvasChannels.events.CREATED, { canvas: summary })
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
      emitCanvasEvent(CanvasChannels.events.UPDATED, { canvas: summary })
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
}

export function unregisterCanvasHandlers(): void {
  ipcMain.removeHandler(CanvasChannels.invoke.CREATE)
  ipcMain.removeHandler(CanvasChannels.invoke.GET)
  ipcMain.removeHandler(CanvasChannels.invoke.UPDATE)
  ipcMain.removeHandler(CanvasChannels.invoke.DELETE)
  ipcMain.removeHandler(CanvasChannels.invoke.LIST)
  if (vaultKeyPromise) {
    void vaultKeyPromise.then((key) => secureCleanup(key)).catch(() => {})
    vaultKeyPromise = null
  }
}
