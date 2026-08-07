/**
 * Adversarial probes for Remediation A (store / reconcile / manifest).
 *
 * Each block states the rule it is trying to break, not the code path it walks.
 * Nothing here is a convenience wrapper over the suites next door: every
 * assertion is one an existing test does NOT make.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '@memry/db-schema/data-schema'
import { canvasFolderSyncId } from '@memry/contracts/canvas-folder-types'
import { OFFLINE_CLOCK_DEVICE_ID } from '@memry/contracts/sync-api'

/**
 * The sync queue is stubbed the way both canvas suites already stub it — the
 * real module drags the whole sync runtime (and electron) in. The probes below
 * re-point `enqueueLocalSyncUpdate` at the REAL offline-clock fallback when they
 * need to prove a clock actually moved.
 */
const syncMock = vi.hoisted(() => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))
vi.mock('../sync/local-mutations', () => syncMock)

import { incrementCanvasFolderClockOffline } from '../sync/offline-clock'
import { createCanvas, deleteCanvas, listCanvases, updateCanvas } from './store'
import { createCanvasFolder, deleteCanvasFolder, listCanvasFolders } from './folder-store'
import { reconcileCanvasFiles } from './reconcile'
import { CANVAS_DIR, withCanvasMeta } from './scene-file'

const MIGRATIONS = [
  '0035_spatial_canvas.sql',
  '0036_canvas_assets.sql',
  '0038_canvas_library_items.sql',
  '0045_canvas_files.sql',
  '0048_canvas_folders.sql'
]

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  for (const file of MIGRATIONS) {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'database', 'drizzle-data', file),
      'utf8'
    )
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) sqlite.exec(trimmed)
    }
  }
  return drizzle(sqlite, { schema })
}

const VAULT_ID = 'vault-1'
const SCENE = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'r1' }] })

let db: ReturnType<typeof freshDb>
let vault: string

beforeEach(() => {
  db = freshDb()
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-canvas-probe-'))
  syncMock.enqueueLocalSyncCreate.mockReset()
  syncMock.enqueueLocalSyncUpdate.mockReset()
  syncMock.enqueueLocalSyncDelete.mockReset()
})

afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true })
})

/** The directories that exist directly under `canvases/`. */
function canvasSubdirs(): string[] {
  return fs
    .readdirSync(path.join(vault, CANVAS_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

describe('P1 — a canvas moved into a folder requested as CON', () => {
  it('stores the directory that is really on disk, and the folder-scoped query finds it', async () => {
    // The folder row is made first, exactly as the sidebar does it: `CON` is a
    // Windows device name, so the directory it can actually own is `CON canvas`.
    const folder = createCanvasFolder(db, vault, VAULT_ID, null, 'CON')
    const canvas = createCanvas(db, vault, VAULT_ID, { title: 'Plan', scene: SCENE })

    const moved = updateCanvas(db, vault, canvas.id, { folder: 'CON' })

    // 1. The stored string IS the directory name, character for character.
    const storedFolder = db.select().from(schema.canvases).all()[0].folder
    expect(canvasSubdirs()).toEqual([storedFolder])
    expect(storedFolder).toBe('CON canvas')
    expect(moved.ok && moved.summary.folder).toBe(storedFolder)
    expect(folder.path).toBe(storedFolder)
    // And the document really sits in it.
    expect(db.select().from(schema.canvases).all()[0].filePath).toBe(
      `${CANVAS_DIR}/CON canvas/Plan.excalidraw`
    )
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'CON canvas', 'Plan.excalidraw'))).toBe(true)

    // 2. A folder-scoped query finds the canvas. `deleteCanvasFolder` is the one
    // that matters: it returns the canvases it swept up, so a canvas filed under
    // a folder string the index cannot match would be left behind — visible in a
    // folder the app just deleted.
    const swept = await deleteCanvasFolder(db, vault, VAULT_ID, 'CON', async (abs) => {
      fs.rmSync(abs, { recursive: true, force: true })
    })
    expect(swept).toEqual([canvas.id])
    expect(listCanvases(db, VAULT_ID)).toEqual([])
  })
})

describe('P2 — a canvas the user deleted in the app', () => {
  it('is not counted as a missing document when the trash took the file', async () => {
    const kept = createCanvas(db, vault, VAULT_ID, { title: 'Kept', scene: SCENE })
    const dropped = createCanvas(db, vault, VAULT_ID, { title: 'Dropped', scene: SCENE })
    await deleteCanvas(db, vault, dropped.id, async (abs) => fs.rmSync(abs))

    const result = await reconcileCanvasFiles(db, vault, VAULT_ID)

    // The tombstone keeps `file_path` populated (it is the sync truth), so an
    // unfiltered scan re-counts every canvas the user ever deleted, forever.
    expect(result.missingFiles).toBe(0)
    expect(listCanvases(db, VAULT_ID).map((row) => row.id)).toEqual([kept.id])
  })

  it('is not re-adopted as a new canvas when the trash left the file behind', async () => {
    // The trash is unavailable (network volume, some Linux setups) and the
    // fallback unlink also fails — the row is a tombstone, the document is not.
    const dropped = createCanvas(db, vault, VAULT_ID, { title: 'Dropped', scene: SCENE })
    const filePath = db.select().from(schema.canvases).all()[0].filePath!
    await deleteCanvas(db, vault, dropped.id, async () => {})
    expect(fs.existsSync(path.join(vault, filePath))).toBe(true)

    const result = await reconcileCanvasFiles(db, vault, VAULT_ID)

    // Adopting it would hand the user back the canvas they just deleted, under
    // a brand-new id, on every vault open.
    expect(result.adopted).toBe(0)
    expect(result.missingFiles).toBe(0)
    expect(listCanvases(db, VAULT_ID)).toEqual([])
    expect(db.select().from(schema.canvases).all()).toHaveLength(1)
  })
})

describe('P3 — a folder row with no directory, in both directions', () => {
  it('disk→row: a directory removed in Finder comes back, and its canvases are reported, never tombstoned', async () => {
    createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
    const canvas = createCanvas(db, vault, VAULT_ID, {
      title: 'Plan',
      folder: 'Work',
      scene: SCENE
    })
    fs.rmSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })

    const result = await reconcileCanvasFiles(db, vault, VAULT_ID)

    expect(result.foldersRestored).toBe(1)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work'))).toBe(true)
    // Never a tombstone, on either row — a half-copied vault (or a cloud client
    // mid-sync) looks exactly like this.
    expect(db.select().from(schema.canvasFolders).all()[0].deletedAt).toBeNull()
    const canvasRow = db.select().from(schema.canvases).all()[0]
    expect(canvasRow.id).toBe(canvas.id)
    expect(canvasRow.deletedAt).toBeNull()
    expect(canvasRow.folder).toBe('Work')
    expect(result.missingFiles).toBe(1)
  })

  it('sync→disk: a folder row that arrived from a peer gets its directory, and nothing goes back on the wire', async () => {
    // What `canvas-folder-handler.applyUpsert` leaves behind: a row with a
    // clock, and no directory anywhere.
    db.insert(schema.canvasFolders)
      .values({
        id: canvasFolderSyncId('Shared'),
        vaultId: VAULT_ID,
        path: 'Shared',
        icon: null,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        clock: { 'device-a': 3 }
      })
      .run()

    const result = await reconcileCanvasFiles(db, vault, VAULT_ID)

    expect(result.foldersRestored).toBe(1)
    expect(result.foldersAdopted).toBe(0)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Shared'))).toBe(true)
    expect(db.select().from(schema.canvasFolders).all()[0].deletedAt).toBeNull()
    // Materializing a peer's folder is not a local mutation: pushing anything
    // here would echo the folder straight back at the device that made it.
    expect(syncMock.enqueueLocalSyncDelete).not.toHaveBeenCalled()
    expect(syncMock.enqueueLocalSyncUpdate).not.toHaveBeenCalled()
    expect(syncMock.enqueueLocalSyncCreate).not.toHaveBeenCalled()
    // And the row is untouched, clock included — a bump would take it out of
    // whatever the server already holds for it.
    expect(db.select().from(schema.canvasFolders).all()[0].clock).toEqual({ 'device-a': 3 })
  })
})

describe('P5 — reviving a tombstoned folder', () => {
  /** Wires the stub back onto the REAL offline-clock fallback for this db. */
  function bridgeUpdatesToOfflineClock(): void {
    syncMock.enqueueLocalSyncUpdate.mockImplementation((type: string, itemId: string) => {
      if (type === 'canvas_folder') incrementCanvasFolderClockOffline(db, itemId)
    })
  }

  function writeCanvasFileAt(dir: string[], filename: string, id: string): void {
    fs.mkdirSync(path.join(vault, CANVAS_DIR, ...dir), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, ...dir, filename),
      withCanvasMeta(SCENE, { id, createdAt: 5, updatedAt: 6 })
    )
  }

  it('bumps the row clock through the real fallback, not only the mock', async () => {
    writeCanvasFileAt(['Work'], 'Plan.excalidraw', 'in-work')
    await reconcileCanvasFiles(db, vault, VAULT_ID)
    db.update(schema.canvasFolders)
      .set({ deletedAt: 123, updatedAt: 123, clock: { 'device-a': 4 } })
      .run()
    syncMock.enqueueLocalSyncUpdate.mockClear()
    bridgeUpdatesToOfflineClock()

    await reconcileCanvasFiles(db, vault, VAULT_ID)

    expect(listCanvasFolders(db, VAULT_ID).map((folder) => folder.path)).toEqual(['Work'])
    expect(syncMock.enqueueLocalSyncUpdate).toHaveBeenCalledWith(
      'canvas_folder',
      canvasFolderSyncId('Work')
    )
    // The enqueue is only half the promise: a revived row whose clock never
    // moves loses to the tombstone every peer already holds.
    expect(db.select().from(schema.canvasFolders).all()[0].clock).toEqual({
      'device-a': 4,
      [OFFLINE_CLOCK_DEVICE_ID]: 1
    })
  })

  it('ADVERSARIAL: a trash-refused folder delete leaves the folder deleted, here and everywhere', async () => {
    // `deleteCanvasFolder` refuses to force-remove a directory the OS trash
    // rejected, so the directory AND every canvas file inside it survive — while
    // both rows are tombstoned.
    //
    // A peer's delete reaches the SAME state whenever a file removal fails, and
    // reconcile cannot tell the two apart: tombstoned folder row, tombstoned
    // canvas rows, documents still on disk. So the shared answer has to be the
    // one that respects the delete the user made — the folder stays gone in the
    // app on every device, including this one. Reviving it here would leave the
    // fleet split: back in one sidebar, gone in the others.
    createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
    const canvas = createCanvas(db, vault, VAULT_ID, {
      title: 'Plan',
      folder: 'Work',
      scene: SCENE
    })
    // Both rows have been pushed at least once, so the null-clock rule is not
    // what keeps this folder off the wire — document ownership is.
    db.update(schema.canvasFolders)
      .set({ clock: { 'device-a': 1 } })
      .run()
    db.update(schema.canvases)
      .set({ clock: { 'device-a': 1 } })
      .run()

    await deleteCanvasFolder(db, vault, VAULT_ID, 'Work', async () => {
      throw new Error('trash unavailable')
    })
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work', 'Plan.excalidraw'))).toBe(true)
    syncMock.enqueueLocalSyncUpdate.mockClear()

    const result = await reconcileCanvasFiles(db, vault, VAULT_ID)

    // The folder stays deleted: the only document under it belongs to a
    // TOMBSTONED canvas, so nothing there is alive to bring it back.
    expect(listCanvasFolders(db, VAULT_ID)).toEqual([])
    expect(result.foldersAdopted).toBe(0)
    // The leftover document is not re-adopted either — its row still owns the
    // path — so it is left orphaned on disk rather than resurrected as a canvas.
    expect(result.adopted).toBe(0)
    expect(listCanvases(db, VAULT_ID)).toEqual([])
    expect(
      db.select().from(schema.canvases).where(eq(schema.canvases.id, canvas.id)).get()!.deletedAt
    ).not.toBeNull()
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work', 'Plan.excalidraw'))).toBe(true)
    expect(syncMock.enqueueLocalSyncUpdate).not.toHaveBeenCalled()
  })
})
