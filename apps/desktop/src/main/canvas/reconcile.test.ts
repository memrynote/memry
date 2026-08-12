import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import * as schema from '@memry/db-schema/data-schema'
import { canvasFolderSyncId } from '@memry/contracts/canvas-folder-types'

const legacyVaultKey = vi.hoisted(() => ({ current: null as Uint8Array | null }))

vi.mock('./vault-key', () => ({
  getLegacyCanvasVaultKey: async () => {
    if (!legacyVaultKey.current) throw new Error('Current master key does not match this vault')
    return legacyVaultKey.current
  }
}))

// The folder store pushes its mutations onto the sync queue, which reaches for
// the process-wide database this suite never installs. Hoisted so the reconcile
// tests can assert WHICH mutations reach it — a revival that never pushes is
// invisible to the user's other devices.
const syncMock = vi.hoisted(() => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))
vi.mock('../sync/local-mutations', () => syncMock)

const { reconcileCanvasFiles } = await import('./reconcile')
const { encryptCanvasSceneForVault, encryptCanvasLibraryItemForVault } =
  await import('./encryption')
const { CANVAS_DIR, readCanvasMeta, withCanvasMeta } = await import('./scene-file')
const { readCanvasLibrary } = await import('./library-file')
const { createCanvas, deleteCanvas, getCanvas, listCanvases } = await import('./store')
const { deleteCanvasFolder, listCanvasFolders, renameCanvasFolder, setCanvasFolderIcon } =
  await import('./folder-store')

const MIGRATIONS = [
  '0035_spatial_canvas.sql',
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

const SCENE = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'r1' }] })

let db: ReturnType<typeof freshDb>
let vault: string
let vaultKey: Uint8Array

function insertLegacyRow(id: string, title: string, ciphertext: string): void {
  db.insert(schema.canvases)
    .values({
      id,
      vaultId: 'vault-1',
      title,
      filePath: null,
      snapshotCiphertext: ciphertext,
      vectorClock: {},
      createdAt: 1000,
      updatedAt: 2000,
      deletedAt: null,
      lastSyncedAt: null,
      clock: null
    })
    .run()
}

beforeAll(async () => {
  await sodium.ready
  vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
})

beforeEach(() => {
  db = freshDb()
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-canvas-reconcile-'))
  legacyVaultKey.current = vaultKey
  syncMock.enqueueLocalSyncCreate.mockClear()
  syncMock.enqueueLocalSyncUpdate.mockClear()
  syncMock.enqueueLocalSyncDelete.mockClear()
})

afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true })
})

describe('legacy migration', () => {
  it('writes the encrypted snapshot out as a file and blanks the ciphertext', async () => {
    insertLegacyRow('c1', 'Weekend Plan', encryptCanvasSceneForVault(SCENE, vaultKey))

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.migrated).toBe(1)
    const row = db.select().from(schema.canvases).all()[0]
    expect(row.filePath).toBe(`${CANVAS_DIR}/Weekend Plan.excalidraw`)
    expect(row.snapshotCiphertext).toBe('')
    const onDisk = fs.readFileSync(path.join(vault, row.filePath!), 'utf8')
    expect(JSON.parse(onDisk).elements).toEqual([{ id: 'r1' }])
    expect(readCanvasMeta(onDisk)).toEqual({ id: 'c1', createdAt: 1000, updatedAt: 2000 })
  })

  it('is idempotent — a second open migrates nothing', async () => {
    insertLegacyRow('c1', 'Plan', encryptCanvasSceneForVault(SCENE, vaultKey))

    await reconcileCanvasFiles(db, vault, 'vault-1')
    const second = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(second.migrated).toBe(0)
    expect(second.adopted).toBe(0)
  })

  it('KEEPS the ciphertext when the master key has moved on, and reports it', async () => {
    // This is the free → paid upgrade: the account master key replaced the local
    // one, so the old snapshot no longer decrypts.
    insertLegacyRow('c1', 'Plan', encryptCanvasSceneForVault(SCENE, vaultKey))
    legacyVaultKey.current = sodium.randombytes_buf(
      sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES
    )

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.unreadable).toBe(1)
    expect(result.migrated).toBe(0)
    const row = db.select().from(schema.canvases).all()[0]
    expect(row.filePath).toBeNull()
    // The only copy of that ink is still on disk, recoverable if the old key returns.
    expect(row.snapshotCiphertext).not.toBe('')
  })

  it('survives having no vault key at all (copied vault, no keychain)', async () => {
    insertLegacyRow('c1', 'Plan', encryptCanvasSceneForVault(SCENE, vaultKey))
    legacyVaultKey.current = null

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.unreadable).toBe(1)
    expect(db.select().from(schema.canvases).all()[0].snapshotCiphertext).not.toBe('')
  })

  it('gives same-titled legacy canvases distinct files', async () => {
    insertLegacyRow('c1', 'Plan', encryptCanvasSceneForVault(SCENE, vaultKey))
    insertLegacyRow('c2', 'Plan', encryptCanvasSceneForVault(SCENE, vaultKey))

    await reconcileCanvasFiles(db, vault, 'vault-1')

    const paths = db
      .select({ filePath: schema.canvases.filePath })
      .from(schema.canvases)
      .all()
      .map((row) => row.filePath)
    expect(new Set(paths).size).toBe(2)
  })

  it('migrates the encrypted shapes library into one excalidrawlib file', async () => {
    db.insert(schema.canvasLibraryItems)
      .values({
        id: 'lib1',
        vaultId: 'vault-1',
        itemCiphertext: encryptCanvasLibraryItemForVault(
          JSON.stringify({ id: 'lib1', elements: [] }),
          vaultKey
        ),
        vectorClock: {},
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        lastSyncedAt: null,
        clock: null
      })
      .run()

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.libraryItemsMigrated).toBe(1)
    expect(readCanvasLibrary(vault)).toEqual([{ id: 'lib1', elements: [] }])
    // Second open must not duplicate them.
    expect((await reconcileCanvasFiles(db, vault, 'vault-1')).libraryItemsMigrated).toBe(0)
  })
})

describe('adoption', () => {
  it('adopts a canvas that arrived with a copied vault folder', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, 'From USB.excalidraw'),
      withCanvasMeta(SCENE, { id: 'copied-1', createdAt: 5, updatedAt: 6 })
    )

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.adopted).toBe(1)
    const row = db.select().from(schema.canvases).all()[0]
    expect(row).toMatchObject({
      id: 'copied-1',
      title: 'From USB',
      filePath: `${CANVAS_DIR}/From USB.excalidraw`,
      createdAt: 5,
      // Null clock so the next sync seeds it out to the user's other devices.
      clock: null
    })
  })

  it('adopts a hand-made Excalidraw file and stamps an id into it', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR), { recursive: true })
    fs.writeFileSync(path.join(vault, CANVAS_DIR, 'Sketch.excalidraw'), SCENE)

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.adopted).toBe(1)
    const content = fs.readFileSync(path.join(vault, CANVAS_DIR, 'Sketch.excalidraw'), 'utf8')
    expect(readCanvasMeta(content)?.id).toBe(db.select().from(schema.canvases).all()[0].id)
  })

  it('re-points the index instead of duplicating when a file was renamed outside the app', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, 'Original.excalidraw'),
      withCanvasMeta(SCENE, { id: 'c1', createdAt: 5, updatedAt: 6 })
    )
    await reconcileCanvasFiles(db, vault, 'vault-1')
    fs.renameSync(
      path.join(vault, CANVAS_DIR, 'Original.excalidraw'),
      path.join(vault, CANVAS_DIR, 'Renamed In Finder.excalidraw')
    )

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.adopted).toBe(0)
    expect(db.select().from(schema.canvases).all()).toHaveLength(1)
    expect(db.select().from(schema.canvases).all()[0].filePath).toBe(
      `${CANVAS_DIR}/Renamed In Finder.excalidraw`
    )
  })

  it('indexes the entity refs an adopted scene references', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, 'Linked.excalidraw'),
      withCanvasMeta(
        JSON.stringify({
          type: 'excalidraw',
          elements: [
            { id: 'r1', type: 'rectangle', customData: { entityType: 'note', entityId: 'n1' } }
          ]
        }),
        { id: 'c9', createdAt: 1, updatedAt: 1 }
      )
    )

    await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(db.select().from(schema.canvasEntityRefs).all()).toMatchObject([
      { canvasId: 'c9', entityType: 'note', entityId: 'n1' }
    ])
  })

  it('reports a missing document but NEVER tombstones the row', async () => {
    insertLegacyRow('c1', 'Plan', encryptCanvasSceneForVault(SCENE, vaultKey))
    await reconcileCanvasFiles(db, vault, 'vault-1')
    const row = db.select().from(schema.canvases).all()[0]
    fs.rmSync(path.join(vault, row.filePath!))

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.missingFiles).toBe(1)
    // A half-copied vault must never delete canvases.
    expect(db.select().from(schema.canvases).all()[0].deletedAt).toBeNull()
  })

  it('does nothing, loudly or otherwise, for a vault with no canvases', async () => {
    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result).toEqual({
      migrated: 0,
      unreadable: 0,
      adopted: 0,
      foldersAdopted: 0,
      foldersRestored: 0,
      foldersPruned: 0,
      missingFiles: 0,
      libraryItemsMigrated: 0
    })
  })

  /**
   * `missingFiles` is a fleet-health signal (it ships as a warn metric), so it
   * has to count documents that really vanished — not every canvas the user has
   * ever deleted. `deleteCanvas` tombstones the row and LEAVES `file_path`
   * populated, so an unfiltered scan re-counts each one on every vault open and
   * the number only ever grows.
   */
  it('does not count a canvas the user deleted in the app as a missing document', async () => {
    const kept = createCanvas(db, vault, 'vault-1', { title: 'Kept' })
    const dropped = createCanvas(db, vault, 'vault-1', { title: 'Dropped' })
    await deleteCanvas(db, vault, dropped.id, async (abs) => {
      fs.rmSync(abs)
    })

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.missingFiles).toBe(0)
    expect(getCanvas(db, vault, kept.id)?.unreadable).toBeUndefined()
  })

  /**
   * **A deleted canvas stays deleted, even if its document comes back.**
   *
   * The delete is what every device now agrees on; the file is the truth for
   * INK, not for existence-after-a-delete. Two situations put a document back at
   * a tombstoned row's path and they are indistinguishable from here:
   *
   * - the user restored it from the OS trash, meaning to undo;
   * - a removal FAILED. `deleteCanvasFileSync` is total (a locked file on
   *   Windows, a refused unlink), a peer's `canvasHandler.applyDelete` removes
   *   the document on every other device the same way, and a cloud client can
   *   re-materialize a file mid-sync.
   *
   * Adopting would therefore resurrect the canvas fleet-wide off a failed
   * unlink, and there is no second signal to tell the cases apart — the folder
   * half has one ("does a LIVE canvas row still own a document in here?"); the
   * canvas half has only the file itself. So the delete wins, and the delete
   * confirmation says exactly that instead of promising a restore.
   */
  it('leaves a deleted canvas deleted when its document reappears', async () => {
    const dropped = createCanvas(db, vault, 'vault-1', { title: 'Dropped' })
    const restored: { path: string; content: string }[] = []
    await deleteCanvas(db, vault, dropped.id, async (abs) => {
      restored.push({ path: abs, content: fs.readFileSync(abs, 'utf8') })
      fs.rmSync(abs)
    })
    // The user drags the file back out of the trash, to where it was.
    fs.writeFileSync(restored[0].path, restored[0].content)

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.adopted).toBe(0)
    expect(listCanvases(db, 'vault-1')).toHaveLength(0)
    expect(db.select().from(schema.canvases).all()).toHaveLength(1)
    expect(db.select().from(schema.canvases).all()[0].deletedAt).not.toBeNull()
  })

  it('still counts a live canvas whose document vanished alongside a deleted one', async () => {
    const gone = createCanvas(db, vault, 'vault-1', { title: 'Gone' })
    const dropped = createCanvas(db, vault, 'vault-1', { title: 'Dropped' })
    await deleteCanvas(db, vault, dropped.id, async (abs) => {
      fs.rmSync(abs)
    })
    fs.unlinkSync(path.join(vault, CANVAS_DIR, 'Gone.excalidraw'))

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.missingFiles).toBe(1)
    expect(getCanvas(db, vault, gone.id)?.unreadable).toBe(true)
  })
})

/**
 * The counterpart of "a row whose file is missing is reported, never
 * tombstoned", for folder rows — see the rule stated on
 * `restoreMissingFolderDirs` in `reconcile.ts`.
 */
describe('folder rows whose directory is gone', () => {
  /** A folder row exactly as the sync handler's apply would leave it. */
  function insertSyncedFolderRow(folderPath: string, clock: Record<string, number>): void {
    db.insert(schema.canvasFolders)
      .values({
        id: canvasFolderSyncId(folderPath),
        vaultId: 'vault-1',
        path: folderPath,
        icon: null,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        clock
      })
      .run()
  }

  it('puts back a directory the user removed in Finder, and never tombstones the row', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })
    await reconcileCanvasFiles(db, vault, 'vault-1')
    fs.rmSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.foldersRestored).toBe(1)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work'))).toBe(true)
    expect(db.select().from(schema.canvasFolders).all()[0].deletedAt).toBeNull()
    expect(listCanvasFolders(db, 'vault-1').map((folder) => folder.path)).toEqual(['Work'])
  })

  it('materializes a folder that arrived from sync before its directory existed', async () => {
    // The apply path writes the ROW and emits an event; nothing creates the
    // directory. Tombstoning it here would push a delete straight back at the
    // device that just made the folder.
    insertSyncedFolderRow('Shared', { 'device-a': 3 })

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.foldersRestored).toBe(1)
    expect(result.foldersAdopted).toBe(0)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Shared'))).toBe(true)
    expect(db.select().from(schema.canvasFolders).all()[0].deletedAt).toBeNull()
    // Never a delete push: the folder is alive on the device that made it.
    expect(syncMock.enqueueLocalSyncDelete).not.toHaveBeenCalled()
  })

  it('restores a nested folder at every level', async () => {
    insertSyncedFolderRow('Work', { 'device-a': 1 })
    insertSyncedFolderRow('Work/Q3', { 'device-a': 1 })

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.foldersRestored).toBe(2)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work', 'Q3'))).toBe(true)
  })

  it('leaves a TOMBSTONED folder without a directory alone', async () => {
    // The delete already happened. Recreating the directory would resurrect it
    // on the next adoption pass.
    db.insert(schema.canvasFolders)
      .values({
        id: canvasFolderSyncId('Deleted'),
        vaultId: 'vault-1',
        path: 'Deleted',
        icon: null,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: 999,
        clock: { 'device-a': 2 }
      })
      .run()

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.foldersRestored).toBe(0)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Deleted'))).toBe(false)
    expect(listCanvasFolders(db, 'vault-1')).toEqual([])
  })

  it('is idempotent — a restored tree is restored once', async () => {
    insertSyncedFolderRow('Shared', { 'device-a': 3 })

    await reconcileCanvasFiles(db, vault, 'vault-1')
    const second = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(second.foldersRestored).toBe(0)
    expect(second.foldersAdopted).toBe(0)
  })

  it('leaves a row it could not address alone rather than inventing a directory', async () => {
    // A non-canonical stored path is a row no later lookup resolves; mkdir-ing
    // the canonical name for it would add a directory nothing points at.
    insertSyncedFolderRow('CON', { 'device-a': 1 })

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.foldersRestored).toBe(0)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'CON canvas'))).toBe(false)
  })
})

/**
 * A tombstoned folder comes back only when its directory still holds a document
 * a LIVE canvas row owns — and then it has to reach the user's other devices.
 * See the revival rule on the adoption block in `reconcile.ts`.
 */
describe('reviving a tombstoned folder', () => {
  function tombstoneEveryFolder(clock: Record<string, number> | null): void {
    db.update(schema.canvasFolders).set({ deletedAt: 123, updatedAt: 123, clock }).run()
  }

  it('pushes the revival when the directory still holds the user documents', async () => {
    // `deleteCanvasFolder` leaves the directory exactly when the OS trash refused
    // it — with the documents still inside. That folder is coming back on this
    // device, so it has to come back on the others too.
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, 'Work', 'Plan.excalidraw'),
      withCanvasMeta(SCENE, { id: 'in-work', createdAt: 5, updatedAt: 6 })
    )
    await reconcileCanvasFiles(db, vault, 'vault-1')
    tombstoneEveryFolder({ 'device-a': 4 })
    syncMock.enqueueLocalSyncUpdate.mockClear()

    await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(listCanvasFolders(db, 'vault-1').map((folder) => folder.path)).toEqual(['Work'])
    expect(syncMock.enqueueLocalSyncUpdate).toHaveBeenCalledWith(
      'canvas_folder',
      canvasFolderSyncId('Work')
    )
  })

  it('does NOT revive an empty directory a peer delete left behind, and sweeps it up', async () => {
    // A remote folder delete tombstones the row; the emptied directory can
    // outlive it (the canvas deletes had not applied yet when the folder delete
    // did, so `removeEmptyCanvasFolderDirs` found it occupied). Adopting that
    // back would undo, on this device, the delete the user made on another one —
    // and the delete is already on the wire, so the two devices disagree forever.
    //
    // Deepest-first: the parent cannot go until the tombstoned child has, and
    // `listCanvasFolderDirs` hands them over parent-first.
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work', 'Q3'), { recursive: true })
    await reconcileCanvasFiles(db, vault, 'vault-1')
    tombstoneEveryFolder({ 'device-a': 4 })
    syncMock.enqueueLocalSyncUpdate.mockClear()

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(listCanvasFolders(db, 'vault-1')).toEqual([])
    expect(result.foldersAdopted).toBe(0)
    expect(result.foldersPruned).toBe(2)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work'))).toBe(false)
    expect(syncMock.enqueueLocalSyncUpdate).not.toHaveBeenCalled()
  })

  it('does NOT revive a directory whose only documents belong to tombstoned canvases', async () => {
    // The other half of the peer-delete story: the delete tombstones the folder
    // AND every canvas in it, but removing a canvas file can fail (a locked
    // file, a refused trash), so documents are left behind that no LIVE row
    // owns. Ownership rather than mere presence is what tells the two apart.
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, 'Work', 'Plan.excalidraw'),
      withCanvasMeta(SCENE, { id: 'in-work', createdAt: 5, updatedAt: 6 })
    )
    await reconcileCanvasFiles(db, vault, 'vault-1')
    // The canvas rows go the way a peer delete leaves them: tombstoned, with
    // file_path intact and the document still on disk.
    db.update(schema.canvases).set({ deletedAt: 123, updatedAt: 123 }).run()
    tombstoneEveryFolder({ 'device-a': 4 })
    syncMock.enqueueLocalSyncUpdate.mockClear()

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(listCanvasFolders(db, 'vault-1')).toEqual([])
    expect(result.foldersAdopted).toBe(0)
    expect(syncMock.enqueueLocalSyncUpdate).not.toHaveBeenCalled()
    // Nothing here is ours to delete: the ink is the user's, and the directory
    // holding it stays with it.
    expect(result.foldersPruned).toBe(0)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work', 'Plan.excalidraw'))).toBe(true)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work'))).toBe(true)
  })

  it('takes the folder back when a live canvas lands in it after the sweep', async () => {
    // The sweep is not a dead end. A canvas that arrives late (a half-copied
    // vault, a mid-download Dropbox folder) brings its directory back with it —
    // cloud clients and `writeCanvasFileSync` both mkdir on write — and the
    // folder is real again on the next open.
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })
    await reconcileCanvasFiles(db, vault, 'vault-1')
    tombstoneEveryFolder({ 'device-a': 4 })
    await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work'))).toBe(false)

    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, 'Work', 'Plan.excalidraw'),
      withCanvasMeta(SCENE, { id: 'in-work', createdAt: 5, updatedAt: 6 })
    )
    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(listCanvasFolders(db, 'vault-1').map((folder) => folder.path)).toEqual(['Work'])
    expect(result.foldersPruned).toBe(0)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work'))).toBe(true)
  })

  it('leaves a live folder that happens to be empty exactly where it is', async () => {
    // An empty folder is precisely what the folder table exists to carry. Only a
    // TOMBSTONE makes a directory sweepable.
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })
    await reconcileCanvasFiles(db, vault, 'vault-1')

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.foldersPruned).toBe(0)
    expect(listCanvasFolders(db, 'vault-1').map((folder) => folder.path)).toEqual(['Work'])
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work'))).toBe(true)
  })

  it('leaves a tombstoned directory that still holds anything at all — even a stray file', async () => {
    // Not a canvas, so no row will ever own it: a note the user filed there by
    // hand, a cloud client's leftovers. `rmdir` refuses a non-empty directory and
    // that refusal IS the safety property — nothing here reaches for the content.
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })
    await reconcileCanvasFiles(db, vault, 'vault-1')
    tombstoneEveryFolder({ 'device-a': 4 })
    fs.writeFileSync(path.join(vault, CANVAS_DIR, 'Work', 'notes.md'), '# mine')

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.foldersPruned).toBe(0)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work', 'notes.md'))).toBe(true)
  })

  it('leaves a never-pushed folder to seedUnclocked instead of enqueuing an update', async () => {
    // A null clock means the server has never seen this folder. An `update` push
    // has nothing to update, and any clock bump takes the row out of
    // `seedUnclocked`'s reach — the one thing that would have pushed it.
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, 'Work', 'Plan.excalidraw'),
      withCanvasMeta(SCENE, { id: 'in-work', createdAt: 5, updatedAt: 6 })
    )
    await reconcileCanvasFiles(db, vault, 'vault-1')
    tombstoneEveryFolder(null)
    syncMock.enqueueLocalSyncUpdate.mockClear()

    await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(listCanvasFolders(db, 'vault-1').map((folder) => folder.path)).toEqual(['Work'])
    expect(db.select().from(schema.canvasFolders).all()[0].clock).toBeNull()
    expect(syncMock.enqueueLocalSyncUpdate).not.toHaveBeenCalled()
  })

  it('says nothing about a folder that was never tombstoned', async () => {
    // Documents inside, so the only thing keeping this off the queue is that
    // there was no tombstone: a first-time adoption is `seedUnclocked`'s job.
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, 'Work', 'Plan.excalidraw'),
      withCanvasMeta(SCENE, { id: 'in-work', createdAt: 5, updatedAt: 6 })
    )

    await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(listCanvasFolders(db, 'vault-1').map((folder) => folder.path)).toEqual(['Work'])
    expect(syncMock.enqueueLocalSyncUpdate).not.toHaveBeenCalled()
  })
})

describe('folder reconciliation', () => {
  function writeCanvasAt(relativeDir: string[], filename: string, id: string): void {
    fs.mkdirSync(path.join(vault, CANVAS_DIR, ...relativeDir), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, ...relativeDir, filename),
      withCanvasMeta(SCENE, { id, createdAt: 5, updatedAt: 6 })
    )
  }

  it('adopts a canvas found in a subfolder', async () => {
    writeCanvasAt(['Work'], 'Adopted.excalidraw', 'adopted-1')

    await reconcileCanvasFiles(db, vault, 'vault-1')

    const adopted = listCanvases(db, 'vault-1').find((canvas) => canvas.title === 'Adopted')
    expect(adopted?.folder).toBe('Work')
  })

  it('re-points a canvas the user moved into a folder in Finder', async () => {
    const canvas = createCanvas(db, vault, 'vault-1', { title: 'Plan' })
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })
    fs.renameSync(
      path.join(vault, CANVAS_DIR, 'Plan.excalidraw'),
      path.join(vault, CANVAS_DIR, 'Work', 'Plan.excalidraw')
    )

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.adopted).toBe(0)
    const row = db.select().from(schema.canvases).all()[0]
    expect(row.id).toBe(canvas.id)
    expect(row.folder).toBe('Work')
    // Path is truth for placement: the stored path has to follow the file too,
    // or the ink becomes unreadable on the next open.
    expect(row.filePath).toBe(`${CANVAS_DIR}/Work/Plan.excalidraw`)
  })

  it('re-points a canvas the user dragged back out to the canvases root', async () => {
    const canvas = createCanvas(db, vault, 'vault-1', { title: 'Plan', folder: 'Work' })
    fs.renameSync(
      path.join(vault, CANVAS_DIR, 'Work', 'Plan.excalidraw'),
      path.join(vault, CANVAS_DIR, 'Plan.excalidraw')
    )

    await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(listCanvases(db, 'vault-1').find((row) => row.id === canvas.id)?.folder).toBeNull()
  })

  it('creates folder rows for directories that arrived with the vault', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work', 'Q3'), { recursive: true })

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.foldersAdopted).toBe(2)
    expect(
      listCanvasFolders(db, 'vault-1')
        .map((folder) => folder.path)
        .sort()
    ).toEqual(['Work', 'Work/Q3'])
  })

  it('skips dot-directories, the same way the file walk does', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR, '.trash', 'Work'), { recursive: true })

    await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(listCanvasFolders(db, 'vault-1')).toEqual([])
  })

  it('is idempotent — a second open adopts no folder twice', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })

    await reconcileCanvasFiles(db, vault, 'vault-1')
    const created = listCanvasFolders(db, 'vault-1')[0]
    const second = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(second.foldersAdopted).toBe(0)
    expect(listCanvasFolders(db, 'vault-1')).toEqual([created])
  })

  it('does not bring back a folder whose trash was refused — the delete stands', async () => {
    // `deleteCanvasFolder` leaves the directory in place when the OS trash is
    // unavailable. It tombstones the folder AND every canvas in it, and the
    // delete is already on the wire — so re-adopting the leftover directory
    // would undo, on this device only, what the user asked for on all of them.
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })
    await reconcileCanvasFiles(db, vault, 'vault-1')
    await deleteCanvasFolder(db, vault, 'vault-1', 'Work', async () => {
      throw new Error('trash unavailable')
    })

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(listCanvasFolders(db, 'vault-1')).toEqual([])
    // Swept rather than re-adopted: the folder is deleted and the directory
    // holds nothing, so there is nothing the OS trash could have saved.
    expect(result.foldersPruned).toBe(1)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work'))).toBe(false)
  })

  it('never tombstones a row whose file is missing', async () => {
    const canvas = createCanvas(db, vault, 'vault-1', { title: 'Gone' })
    fs.unlinkSync(path.join(vault, CANVAS_DIR, 'Gone.excalidraw'))

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.missingFiles).toBe(1)
    // Surfaced as unreadable so the editor refuses to mount and cannot autosave
    // over ink that is only misplaced.
    expect(getCanvas(db, vault, canvas.id)?.unreadable).toBe(true)
    expect(db.select().from(schema.canvases).all()[0].deletedAt).toBeNull()
  })

  it('reports NO missing document for a canvas the user moved in Finder', async () => {
    // The missing-file scan must see the re-pointed row, not the snapshot taken
    // before adoption ran — otherwise every Finder move mints a phantom.
    const canvas = createCanvas(db, vault, 'vault-1', { title: 'Plan' })
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })
    fs.renameSync(
      path.join(vault, CANVAS_DIR, 'Plan.excalidraw'),
      path.join(vault, CANVAS_DIR, 'Work', 'Plan.excalidraw')
    )

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.missingFiles).toBe(0)
    expect(getCanvas(db, vault, canvas.id)?.unreadable).toBeUndefined()
  })
})

describe('non-portable directory names', () => {
  it('adopts a Windows-reserved directory under its canonical name, addressable afterwards', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'CON'), { recursive: true })

    await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(listCanvasFolders(db, 'vault-1').map((folder) => folder.path)).toEqual(['CON canvas'])
    // The directory is renamed to match, so the row addresses something real.
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'CON canvas'))).toBe(true)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'CON'))).toBe(false)
    // The whole point: every later lookup canonicalizes, so a raw row would miss.
    expect(setCanvasFolderIcon(db, 'vault-1', 'CON canvas', '📁')?.icon).toBe('📁')
  })

  it('adopts a trailing-space directory under its trimmed name', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work '), { recursive: true })

    await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(listCanvasFolders(db, 'vault-1').map((folder) => folder.path)).toEqual(['Work'])
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work'))).toBe(true)
    expect(setCanvasFolderIcon(db, 'vault-1', 'Work', '📁')?.icon).toBe('📁')
  })

  it('files a canvas inside a non-portable directory under the canonical folder', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work '), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, 'Work ', 'Plan.excalidraw'),
      withCanvasMeta(SCENE, { id: 'in-work', createdAt: 5, updatedAt: 6 })
    )

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.missingFiles).toBe(0)
    const row = db.select().from(schema.canvases).all()[0]
    expect(row.folder).toBe('Work')
    expect(row.filePath).toBe(`${CANVAS_DIR}/Work/Plan.excalidraw`)
  })

  it('is idempotent — a canonical tree is left exactly as it is', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'CON', 'Q3'), { recursive: true })

    await reconcileCanvasFiles(db, vault, 'vault-1')
    const second = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(second.foldersAdopted).toBe(0)
    expect(
      listCanvasFolders(db, 'vault-1')
        .map((folder) => folder.path)
        .sort()
    ).toEqual(['CON canvas', 'CON canvas/Q3'])
  })

  it('leaves a directory it cannot canonicalize unindexed', async () => {
    // A whitespace-only name sanitizes away entirely, so there is no canonical
    // directory to rename it to — and a row holding the raw name is a folder the
    // app could never address again.
    fs.mkdirSync(path.join(vault, CANVAS_DIR, ' '), { recursive: true })

    await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(listCanvasFolders(db, 'vault-1')).toEqual([])
  })

  it('does not clobber a directory already holding the canonical name', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })
    fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work '), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, 'Work', 'Kept.excalidraw'),
      withCanvasMeta(SCENE, { id: 'kept', createdAt: 5, updatedAt: 6 })
    )

    await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(
      listCanvasFolders(db, 'vault-1')
        .map((folder) => folder.path)
        .sort()
    ).toEqual(['Work', 'Work 2'])
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work', 'Kept.excalidraw'))).toBe(true)
  })
})

describe('duplicated documents', () => {
  it('adopts a Finder copy as its own canvas instead of fighting over the row', async () => {
    const canvas = createCanvas(db, vault, 'vault-1', { title: 'Plan' })
    fs.copyFileSync(
      path.join(vault, CANVAS_DIR, 'Plan.excalidraw'),
      path.join(vault, CANVAS_DIR, 'Plan copy.excalidraw')
    )

    const first = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(first.adopted).toBe(1)
    expect(first.missingFiles).toBe(0)
    const rows = db.select().from(schema.canvases).all()
    expect(rows).toHaveLength(2)
    // The original keeps the file it was already bound to.
    expect(rows.find((row) => row.id === canvas.id)?.filePath).toBe(`${CANVAS_DIR}/Plan.excalidraw`)
    const copy = rows.find((row) => row.id !== canvas.id)!
    expect(copy.filePath).toBe(`${CANVAS_DIR}/Plan copy.excalidraw`)
    // The copy's sidecar is re-stamped, so the file is self-describing again.
    expect(
      readCanvasMeta(fs.readFileSync(path.join(vault, CANVAS_DIR, 'Plan copy.excalidraw'), 'utf8'))
        ?.id
    ).toBe(copy.id)
  })

  it('keeps both documents stable across a second open', async () => {
    const canvas = createCanvas(db, vault, 'vault-1', { title: 'Plan' })
    fs.copyFileSync(
      path.join(vault, CANVAS_DIR, 'Plan.excalidraw'),
      path.join(vault, CANVAS_DIR, 'Plan copy.excalidraw')
    )
    await reconcileCanvasFiles(db, vault, 'vault-1')
    const before = db
      .select({ id: schema.canvases.id, filePath: schema.canvases.filePath })
      .from(schema.canvases)
      .all()
      .sort((a, b) => a.id.localeCompare(b.id))

    const second = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(second.adopted).toBe(0)
    expect(second.missingFiles).toBe(0)
    expect(
      db
        .select({ id: schema.canvases.id, filePath: schema.canvases.filePath })
        .from(schema.canvases)
        .all()
        .sort((a, b) => a.id.localeCompare(b.id))
    ).toEqual(before)
    expect(getCanvas(db, vault, canvas.id)?.unreadable).toBeUndefined()
  })

  it('still re-points, not duplicates, when the bound file really moved', async () => {
    const canvas = createCanvas(db, vault, 'vault-1', { title: 'Plan' })
    fs.renameSync(
      path.join(vault, CANVAS_DIR, 'Plan.excalidraw'),
      path.join(vault, CANVAS_DIR, 'Moved.excalidraw')
    )

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.adopted).toBe(0)
    expect(db.select().from(schema.canvases).all()).toHaveLength(1)
    expect(db.select().from(schema.canvases).all()[0].id).toBe(canvas.id)
  })

  it('re-points once, then splits, when the file was renamed AND copied', async () => {
    // The row's binding is dead (Plan.excalidraw is gone), so the first file
    // takes it — and the second must see that fresh binding, not the dead one,
    // or the row would keep hopping between the two copies.
    const canvas = createCanvas(db, vault, 'vault-1', { title: 'Plan' })
    fs.renameSync(
      path.join(vault, CANVAS_DIR, 'Plan.excalidraw'),
      path.join(vault, CANVAS_DIR, 'Moved.excalidraw')
    )
    fs.copyFileSync(
      path.join(vault, CANVAS_DIR, 'Moved.excalidraw'),
      path.join(vault, CANVAS_DIR, 'Zed.excalidraw')
    )

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.adopted).toBe(1)
    const rows = db.select().from(schema.canvases).all()
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === canvas.id)?.filePath).toBe(
      `${CANVAS_DIR}/Moved.excalidraw`
    )
    expect(rows.find((row) => row.id !== canvas.id)?.filePath).toBe(`${CANVAS_DIR}/Zed.excalidraw`)
  })

  it('splits two id-sharing files that arrived together with a copied vault', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR), { recursive: true })
    for (const name of ['A.excalidraw', 'B.excalidraw']) {
      fs.writeFileSync(
        path.join(vault, CANVAS_DIR, name),
        withCanvasMeta(SCENE, { id: 'shared', createdAt: 5, updatedAt: 6 })
      )
    }

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.adopted).toBe(2)
    const rows = db.select().from(schema.canvases).all()
    expect(new Set(rows.map((row) => row.id)).size).toBe(2)
    expect(rows.map((row) => row.filePath).sort()).toEqual([
      `${CANVAS_DIR}/A.excalidraw`,
      `${CANVAS_DIR}/B.excalidraw`
    ])
  })
})

/**
 * Adversarial probes over the three failure modes the remediation exists for:
 * a Finder move must not mint a phantom missing document, a directory the user
 * named `CON` or `Work ` must stay addressable by folder-store's canonicalizing
 * lookups, and two files sharing one sidecar id must settle into two stable
 * documents rather than ping-ponging one row between them.
 */
describe('adversarial reconciliation probes', () => {
  /** Every stored placement, as a stable, comparable snapshot. */
  function placements(): { id: string; filePath: string | null; folder: string | null }[] {
    return db
      .select({
        id: schema.canvases.id,
        filePath: schema.canvases.filePath,
        folder: schema.canvases.folder
      })
      .from(schema.canvases)
      .all()
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  function moveOnDisk(from: string[], to: string[]): void {
    fs.mkdirSync(path.join(vault, CANVAS_DIR, ...to.slice(0, -1)), { recursive: true })
    fs.renameSync(path.join(vault, CANVAS_DIR, ...from), path.join(vault, CANVAS_DIR, ...to))
  }

  describe('a move in Finder never reports a phantom missing document', () => {
    it('follows a canvas dragged from one subfolder into another', async () => {
      const canvas = createCanvas(db, vault, 'vault-1', { title: 'Plan', folder: 'Work' })
      moveOnDisk(['Work', 'Plan.excalidraw'], ['Personal', 'Q3', 'Plan.excalidraw'])

      const result = await reconcileCanvasFiles(db, vault, 'vault-1')

      expect(result.missingFiles).toBe(0)
      expect(result.adopted).toBe(0)
      expect(placements()).toEqual([
        {
          id: canvas.id,
          filePath: `${CANVAS_DIR}/Personal/Q3/Plan.excalidraw`,
          folder: 'Personal/Q3'
        }
      ])
      expect(getCanvas(db, vault, canvas.id)?.unreadable).toBeUndefined()
    })

    it('follows a canvas moved AND renamed in the same drag', async () => {
      const canvas = createCanvas(db, vault, 'vault-1', { title: 'Plan', folder: 'Work' })
      moveOnDisk(['Work', 'Plan.excalidraw'], ['Archive', 'Old Plan.excalidraw'])

      const result = await reconcileCanvasFiles(db, vault, 'vault-1')

      expect(result.missingFiles).toBe(0)
      expect(placements()).toEqual([
        { id: canvas.id, filePath: `${CANVAS_DIR}/Archive/Old Plan.excalidraw`, folder: 'Archive' }
      ])
    })

    it('follows every canvas when a whole folder is dragged at once', async () => {
      const ids = ['One', 'Two', 'Three'].map(
        (title) => createCanvas(db, vault, 'vault-1', { title, folder: 'Work' }).id
      )
      fs.renameSync(path.join(vault, CANVAS_DIR, 'Work'), path.join(vault, CANVAS_DIR, 'Archive'))

      const result = await reconcileCanvasFiles(db, vault, 'vault-1')

      expect(result.missingFiles).toBe(0)
      expect(result.adopted).toBe(0)
      expect(placements()).toEqual(
        [...ids]
          .sort((a, b) => a.localeCompare(b))
          .map((id) => ({
            id,
            filePath: expect.stringMatching(new RegExp(`^${CANVAS_DIR}/Archive/`)),
            folder: 'Archive'
          }))
      )
    })

    it('follows a canvas dragged into a directory the user named non-portably', async () => {
      // The canonicalizing rename runs BEFORE the file walk, so the row is
      // re-pointed at the canonical path in the same pass that renames it — a
      // walk-first ordering would bind the row to `Work ` and then report the
      // canonical path as a document nobody has.
      const canvas = createCanvas(db, vault, 'vault-1', { title: 'Plan' })
      moveOnDisk(['Plan.excalidraw'], ['Work ', 'Plan.excalidraw'])

      const result = await reconcileCanvasFiles(db, vault, 'vault-1')

      expect(result.missingFiles).toBe(0)
      expect(result.adopted).toBe(0)
      expect(placements()).toEqual([
        { id: canvas.id, filePath: `${CANVAS_DIR}/Work/Plan.excalidraw`, folder: 'Work' }
      ])
      expect(getCanvas(db, vault, canvas.id)?.unreadable).toBeUndefined()
    })

    it('still reports — and still never tombstones — a document that really vanished', async () => {
      const moved = createCanvas(db, vault, 'vault-1', { title: 'Moved' })
      const gone = createCanvas(db, vault, 'vault-1', { title: 'Gone' })
      moveOnDisk(['Moved.excalidraw'], ['Work', 'Moved.excalidraw'])
      fs.unlinkSync(path.join(vault, CANVAS_DIR, 'Gone.excalidraw'))

      const result = await reconcileCanvasFiles(db, vault, 'vault-1')

      // Exactly one: the move must not add to the count, and the real loss must
      // not be swallowed by the re-read either.
      expect(result.missingFiles).toBe(1)
      expect(getCanvas(db, vault, moved.id)?.unreadable).toBeUndefined()
      expect(getCanvas(db, vault, gone.id)?.unreadable).toBe(true)
      expect(
        db
          .select()
          .from(schema.canvases)
          .all()
          .every((row) => row.deletedAt === null)
      ).toBe(true)
    })
  })

  describe('a non-portable directory stays addressable after adoption', () => {
    it('renames and re-icons a `CON` directory through both spellings', async () => {
      fs.mkdirSync(path.join(vault, CANVAS_DIR, 'CON'), { recursive: true })
      fs.writeFileSync(
        path.join(vault, CANVAS_DIR, 'CON', 'Plan.excalidraw'),
        withCanvasMeta(SCENE, { id: 'in-con', createdAt: 5, updatedAt: 6 })
      )

      await reconcileCanvasFiles(db, vault, 'vault-1')

      expect(listCanvasFolders(db, 'vault-1').map((folder) => folder.path)).toEqual(['CON canvas'])
      // The raw name the user typed in Finder resolves too: every folder-store
      // entry point canonicalizes before it touches a row.
      expect(setCanvasFolderIcon(db, 'vault-1', 'CON', '📁')?.icon).toBe('📁')

      const renamed = renameCanvasFolder(db, vault, 'vault-1', 'CON', 'Archive')

      expect(renamed?.path).toBe('Archive')
      // The icon survives the rename, which is the only thing this table carries
      // that the directory cannot.
      expect(renamed?.icon).toBe('📁')
      expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Archive', 'Plan.excalidraw'))).toBe(true)
      expect(placements()).toEqual([
        { id: 'in-con', filePath: `${CANVAS_DIR}/Archive/Plan.excalidraw`, folder: 'Archive' }
      ])

      // And the vault is quiet on the next open: nothing missing, nothing
      // re-adopted, no second folder row for the directory that just moved.
      const second = await reconcileCanvasFiles(db, vault, 'vault-1')
      expect(second).toMatchObject({ missingFiles: 0, adopted: 0, foldersAdopted: 0 })
      expect(listCanvasFolders(db, 'vault-1').map((folder) => folder.path)).toEqual(['Archive'])
    })

    it('renames and re-icons a trailing-space directory through both spellings', async () => {
      fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work '), { recursive: true })
      fs.writeFileSync(
        path.join(vault, CANVAS_DIR, 'Work ', 'Plan.excalidraw'),
        withCanvasMeta(SCENE, { id: 'in-work', createdAt: 5, updatedAt: 6 })
      )

      await reconcileCanvasFiles(db, vault, 'vault-1')

      expect(listCanvasFolders(db, 'vault-1').map((folder) => folder.path)).toEqual(['Work'])
      expect(setCanvasFolderIcon(db, 'vault-1', 'Work ', '🗂️')?.icon).toBe('🗂️')

      const renamed = renameCanvasFolder(db, vault, 'vault-1', 'Work ', 'Personal')

      expect(renamed?.path).toBe('Personal')
      expect(renamed?.icon).toBe('🗂️')
      expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Personal', 'Plan.excalidraw'))).toBe(true)
      expect(placements()).toEqual([
        { id: 'in-work', filePath: `${CANVAS_DIR}/Personal/Plan.excalidraw`, folder: 'Personal' }
      ])

      const second = await reconcileCanvasFiles(db, vault, 'vault-1')
      expect(second).toMatchObject({ missingFiles: 0, adopted: 0, foldersAdopted: 0 })
    })

    it('keeps a nested non-portable directory addressable at every level', async () => {
      fs.mkdirSync(path.join(vault, CANVAS_DIR, 'CON', 'Work '), { recursive: true })

      await reconcileCanvasFiles(db, vault, 'vault-1')

      expect(
        listCanvasFolders(db, 'vault-1')
          .map((folder) => folder.path)
          .sort()
      ).toEqual(['CON canvas', 'CON canvas/Work'])
      // The child is reachable by the raw path the user made in Finder.
      expect(setCanvasFolderIcon(db, 'vault-1', 'CON/Work ', '📦')?.icon).toBe('📦')
      expect(renameCanvasFolder(db, vault, 'vault-1', 'CON/Work ', 'Q3')?.path).toBe(
        'CON canvas/Q3'
      )
      expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'CON canvas', 'Q3'))).toBe(true)
    })
  })

  describe('two files sharing one sidecar id settle into two stable documents', () => {
    it('does not ping-pong the row between a canvas and its Finder copy', async () => {
      const canvas = createCanvas(db, vault, 'vault-1', { title: 'Plan' })
      fs.copyFileSync(
        path.join(vault, CANVAS_DIR, 'Plan.excalidraw'),
        path.join(vault, CANVAS_DIR, 'Plan copy.excalidraw')
      )

      const first = await reconcileCanvasFiles(db, vault, 'vault-1')
      const afterFirst = placements()
      const second = await reconcileCanvasFiles(db, vault, 'vault-1')
      const afterSecond = placements()
      const third = await reconcileCanvasFiles(db, vault, 'vault-1')

      expect(first.adopted).toBe(1)
      expect(second).toMatchObject({ adopted: 0, missingFiles: 0 })
      expect(third).toMatchObject({ adopted: 0, missingFiles: 0 })
      expect(afterSecond).toEqual(afterFirst)
      expect(placements()).toEqual(afterFirst)
      // Both documents are independently readable — neither row is left pointing
      // at a file the other one owns.
      expect(afterFirst).toHaveLength(2)
      for (const row of afterFirst) {
        expect(getCanvas(db, vault, row.id)?.unreadable).toBeUndefined()
      }
      expect(afterFirst.find((row) => row.id === canvas.id)?.filePath).toBe(
        `${CANVAS_DIR}/Plan.excalidraw`
      )
    })

    it('stays stable when the copy lands in a different folder', async () => {
      const canvas = createCanvas(db, vault, 'vault-1', { title: 'Plan' })
      fs.mkdirSync(path.join(vault, CANVAS_DIR, 'Work'), { recursive: true })
      fs.copyFileSync(
        path.join(vault, CANVAS_DIR, 'Plan.excalidraw'),
        path.join(vault, CANVAS_DIR, 'Work', 'Plan.excalidraw')
      )

      await reconcileCanvasFiles(db, vault, 'vault-1')
      const afterFirst = placements()
      const second = await reconcileCanvasFiles(db, vault, 'vault-1')

      expect(second).toMatchObject({ adopted: 0, missingFiles: 0 })
      expect(placements()).toEqual(afterFirst)
      expect(afterFirst.find((row) => row.id === canvas.id)).toEqual({
        id: canvas.id,
        filePath: `${CANVAS_DIR}/Plan.excalidraw`,
        folder: null
      })
      expect(afterFirst.find((row) => row.id !== canvas.id)).toEqual({
        id: expect.any(String),
        filePath: `${CANVAS_DIR}/Work/Plan.excalidraw`,
        folder: 'Work'
      })
    })

    it('splits three id-sharing files and keeps all three across a second open', async () => {
      fs.mkdirSync(path.join(vault, CANVAS_DIR), { recursive: true })
      for (const name of ['A.excalidraw', 'B.excalidraw', 'C.excalidraw']) {
        fs.writeFileSync(
          path.join(vault, CANVAS_DIR, name),
          withCanvasMeta(SCENE, { id: 'shared', createdAt: 5, updatedAt: 6 })
        )
      }

      const first = await reconcileCanvasFiles(db, vault, 'vault-1')
      const afterFirst = placements()
      const second = await reconcileCanvasFiles(db, vault, 'vault-1')

      expect(first.adopted).toBe(3)
      expect(second).toMatchObject({ adopted: 0, missingFiles: 0 })
      expect(new Set(afterFirst.map((row) => row.id)).size).toBe(3)
      expect(afterFirst.map((row) => row.filePath).sort()).toEqual([
        `${CANVAS_DIR}/A.excalidraw`,
        `${CANVAS_DIR}/B.excalidraw`,
        `${CANVAS_DIR}/C.excalidraw`
      ])
      expect(placements()).toEqual(afterFirst)
      // Every file now names the document it actually is, so the next copy
      // splits off the right row instead of re-fighting this one.
      for (const row of afterFirst) {
        const content = fs.readFileSync(path.join(vault, row.filePath!), 'utf8')
        expect(readCanvasMeta(content)?.id).toBe(row.id)
      }
    })
  })
})
