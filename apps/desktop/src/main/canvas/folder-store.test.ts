import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import { canvasFolderSyncId } from '@memry/contracts/canvas-folder-types'

/**
 * The sync queue is stubbed: this suite is about WHICH mutations reach it, and
 * the real module pulls the whole sync runtime (and electron) along.
 */
const syncMock = vi.hoisted(() => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))
vi.mock('../sync/local-mutations', () => syncMock)

import {
  CanvasFolderError,
  CanvasFolderErrorCode,
  createCanvasFolder,
  deleteCanvasFolder,
  listCanvasFolders,
  moveCanvasFolder,
  renameCanvasFolder,
  setCanvasFolderIcon
} from './folder-store'
import { createCanvas, listCanvases } from './store'
import { CANVAS_DIR } from './scene-file'
import { MAX_CANVAS_FOLDER_DEPTH } from './folder-paths'

const MIGRATIONS = [
  '0035_spatial_canvas.sql',
  '0036_canvas_assets.sql',
  '0045_canvas_files.sql',
  '0048_canvas_folders.sql'
]

/**
 * The raw handle behind the drizzle db, so a test can make the DATABASE fail for
 * real (`PRAGMA query_only`) instead of stubbing the store's own internals.
 */
let sqliteHandle: Database.Database

function freshDb() {
  const sqlite = new Database(':memory:')
  sqliteHandle = sqlite
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

/** Stand-in for `shell.trashItem`. The store must not care which it is. */
const rmAsTrash = async (absolutePath: string): Promise<void> => {
  fs.rmSync(absolutePath, { recursive: true, force: true })
}

describe('canvas folder store', () => {
  let db: ReturnType<typeof freshDb>
  let vault: string

  beforeEach(() => {
    db = freshDb()
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-canvas-folders-'))
    syncMock.enqueueLocalSyncCreate.mockClear()
    syncMock.enqueueLocalSyncUpdate.mockClear()
    syncMock.enqueueLocalSyncDelete.mockClear()
  })

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true })
  })

  const folderPaths = (): string[] => listCanvasFolders(db, VAULT_ID).map((f) => f.path)
  const dirExists = (...segments: string[]): boolean =>
    fs.existsSync(path.join(vault, CANVAS_DIR, ...segments))

  describe('createCanvasFolder', () => {
    it('creates a real directory and a row keyed by the path', () => {
      const folder = createCanvasFolder(db, vault, VAULT_ID, null, 'Work')

      expect(folder.path).toBe('Work')
      expect(folder.id).toBe(canvasFolderSyncId('Work'))
      expect(dirExists('Work')).toBe(true)
      expect(folderPaths()).toEqual(['Work'])
    })

    it('nests under a parent', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')

      expect(createCanvasFolder(db, vault, VAULT_ID, 'Work', 'Q3').path).toBe('Work/Q3')
      expect(dirExists('Work', 'Q3')).toBe(true)
    })

    it('stores the folder that exists on disk, not the one that was asked for', () => {
      // `CON` is a reserved Windows device name, so the directory that gets
      // created is `CON canvas`. A row holding `CON` would point the index at a
      // directory that does not exist.
      const folder = createCanvasFolder(db, vault, VAULT_ID, null, 'CON')

      expect(folder.path).toBe('CON canvas')
      expect(folder.id).toBe(canvasFolderSyncId('CON canvas'))
      expect(dirExists('CON canvas')).toBe(true)
    })

    it('revives a tombstoned folder instead of colliding with it', async () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      await deleteCanvasFolder(db, vault, VAULT_ID, 'Work', rmAsTrash)
      expect(folderPaths()).toEqual([])

      const revived = createCanvasFolder(db, vault, VAULT_ID, null, 'Work')

      expect(revived.path).toBe('Work')
      expect(folderPaths()).toEqual(['Work'])
    })
  })

  describe('listCanvasFolders', () => {
    it('returns live folders ordered by path, scoped to the vault', async () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      createCanvasFolder(db, vault, VAULT_ID, 'Work', 'Q3')
      createCanvasFolder(db, vault, VAULT_ID, null, 'Archive')
      createCanvasFolder(db, vault, 'vault-2', null, 'Elsewhere')
      const gone = createCanvasFolder(db, vault, VAULT_ID, null, 'Gone')
      await deleteCanvasFolder(db, vault, VAULT_ID, gone.path, rmAsTrash)

      expect(folderPaths()).toEqual(['Archive', 'Work', 'Work/Q3'])
    })
  })

  describe('renameCanvasFolder', () => {
    it('rewrites descendants and child canvases', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      createCanvasFolder(db, vault, VAULT_ID, 'Work', 'Q3')
      const canvas = createCanvas(db, vault, VAULT_ID, {
        title: 'Plan',
        folder: 'Work/Q3',
        scene: SCENE
      })

      const renamed = renameCanvasFolder(db, vault, VAULT_ID, 'Work', 'Job')

      expect(renamed?.path).toBe('Job')
      expect(folderPaths()).toEqual(['Job', 'Job/Q3'])
      expect(listCanvases(db, VAULT_ID).find((c) => c.id === canvas.id)?.folder).toBe('Job/Q3')
      expect(dirExists('Job', 'Q3', 'Plan.excalidraw')).toBe(true)
      expect(dirExists('Work')).toBe(false)
    })

    it('re-points the stored file path so the ink stays reachable', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      createCanvas(db, vault, VAULT_ID, { title: 'Plan', folder: 'Work', scene: SCENE })

      renameCanvasFolder(db, vault, VAULT_ID, 'Work', 'Job')

      const row = db.select().from(schema.canvases).all()[0]
      expect(row.filePath).toBe(`${CANVAS_DIR}/Job/Plan.excalidraw`)
      expect(fs.existsSync(path.join(vault, row.filePath!))).toBe(true)
    })

    it('does not rewrite a folder that merely shares a prefix', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      createCanvasFolder(db, vault, VAULT_ID, null, 'Workshop')
      const outsider = createCanvas(db, vault, VAULT_ID, { title: 'Bench', folder: 'Workshop' })

      renameCanvasFolder(db, vault, VAULT_ID, 'Work', 'Job')

      expect(folderPaths()).toEqual(['Job', 'Workshop'])
      expect(listCanvases(db, VAULT_ID).find((c) => c.id === outsider.id)?.folder).toBe('Workshop')
      expect(dirExists('Workshop')).toBe(true)
    })

    it('keeps the parent when a nested folder is renamed', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      createCanvasFolder(db, vault, VAULT_ID, 'Work', 'Q3')

      expect(renameCanvasFolder(db, vault, VAULT_ID, 'Work/Q3', 'Q4')?.path).toBe('Work/Q4')
      expect(folderPaths()).toEqual(['Work', 'Work/Q4'])
      expect(dirExists('Work', 'Q4')).toBe(true)
    })

    it('survives a case-only rename', () => {
      // The derived id is case-insensitive, so the old row and its replacement
      // are the SAME row here. Tombstoning before reviving is what leaves it
      // live; the other order deletes the folder the user just renamed.
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')

      expect(renameCanvasFolder(db, vault, VAULT_ID, 'Work', 'work')?.path).toBe('work')
      expect(folderPaths()).toEqual(['work'])
    })

    it('carries the icon across', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      setCanvasFolderIcon(db, VAULT_ID, 'Work', '🎨')

      expect(renameCanvasFolder(db, vault, VAULT_ID, 'Work', 'Job')?.icon).toBe('🎨')
      expect(listCanvasFolders(db, VAULT_ID)[0].icon).toBe('🎨')
    })

    it('returns null for a folder that has no live row, touching nothing', () => {
      expect(renameCanvasFolder(db, vault, VAULT_ID, 'Nope', 'Job')).toBeNull()
      // Not even a stray directory: a rename of nothing must create nothing.
      expect(dirExists('Job')).toBe(false)
    })
  })

  describe('moveCanvasFolder', () => {
    it('re-parents the directory, the rows and the canvases inside', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      createCanvasFolder(db, vault, VAULT_ID, null, 'Q3')
      const canvas = createCanvas(db, vault, VAULT_ID, { title: 'Plan', folder: 'Q3' })

      const moved = moveCanvasFolder(db, vault, VAULT_ID, 'Q3', 'Work')

      expect(moved?.path).toBe('Work/Q3')
      expect(folderPaths()).toEqual(['Work', 'Work/Q3'])
      expect(listCanvases(db, VAULT_ID).find((c) => c.id === canvas.id)?.folder).toBe('Work/Q3')
      expect(dirExists('Work', 'Q3', 'Plan.excalidraw')).toBe(true)
    })

    it('moves a folder back to the root', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      createCanvasFolder(db, vault, VAULT_ID, 'Work', 'Q3')

      expect(moveCanvasFolder(db, vault, VAULT_ID, 'Work/Q3', null)?.path).toBe('Q3')
      expect(folderPaths()).toEqual(['Q3', 'Work'])
      expect(dirExists('Q3')).toBe(true)
    })

    it('refuses to move a folder into its own descendant', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      createCanvasFolder(db, vault, VAULT_ID, 'Work', 'Q3')

      expect(() => moveCanvasFolder(db, vault, VAULT_ID, 'Work', 'Work/Q3')).toThrow(/descendant/i)
      // Nothing moved: the subtree would otherwise be unreachable.
      expect(folderPaths()).toEqual(['Work', 'Work/Q3'])
      expect(dirExists('Work', 'Q3')).toBe(true)
    })
  })

  /**
   * The directory and the index name the SAME folder or the canvases inside it
   * become unopenable. Everything here is about keeping those two in step.
   */
  describe('disk and index stay in step', () => {
    it('refuses a destination that is already taken, keeping both folders', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      createCanvasFolder(db, vault, VAULT_ID, null, 'Job')
      setCanvasFolderIcon(db, VAULT_ID, 'Job', '🎨')

      // `renameSync` onto an EMPTY directory succeeds, so this used to absorb
      // `Job` — its row tombstoned, its icon gone, and no error to show for it.
      expect(() => renameCanvasFolder(db, vault, VAULT_ID, 'Work', 'Job')).toThrow(
        CanvasFolderError
      )
      expect(folderPaths()).toEqual(['Job', 'Work'])
      expect(listCanvasFolders(db, VAULT_ID).find((f) => f.path === 'Job')?.icon).toBe('🎨')
      expect(dirExists('Work')).toBe(true)
      expect(dirExists('Job')).toBe(true)
    })

    it('refuses a NON-empty destination without leaking the vault path', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      createCanvasFolder(db, vault, VAULT_ID, null, 'Job')
      createCanvas(db, vault, VAULT_ID, { title: 'Plan', folder: 'Job', scene: SCENE })

      let thrown: unknown
      try {
        renameCanvasFolder(db, vault, VAULT_ID, 'Work', 'Job')
      } catch (err) {
        thrown = err
      }

      // libuv reports ENOTEMPTY with BOTH absolute paths in the message, and
      // this string reaches the UI and telemetry.
      expect(thrown).toBeInstanceOf(CanvasFolderError)
      expect((thrown as CanvasFolderError).code).toBe(CanvasFolderErrorCode.EXISTS)
      expect((thrown as Error).message).not.toContain(vault)
      expect((thrown as Error).message).not.toContain('Job')
      expect(dirExists('Job', 'Plan.excalidraw')).toBe(true)
    })

    it('refuses a move that would push a nested child past the depth cap, moving nothing', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'B')
      const chain: string[] = []
      let parent: string | null = null
      for (let level = 1; level <= MAX_CANVAS_FOLDER_DEPTH; level += 1) {
        const name = level === 1 ? 'A' : `d${level}`
        parent = createCanvasFolder(db, vault, VAULT_ID, parent, name).path
        chain.push(name)
      }
      const deepest = chain.join('/')
      const canvas = createCanvas(db, vault, VAULT_ID, {
        title: 'Plan',
        folder: deepest,
        scene: SCENE
      })

      // One level deeper than the cap once `A` sits under `B`.
      expect(() => moveCanvasFolder(db, vault, VAULT_ID, 'A', 'B')).toThrow(/deeper than/)

      // The throw used to land mid-transaction, with the directory already
      // renamed and the index rolled back — every canvas below unopenable.
      expect(dirExists(...chain, 'Plan.excalidraw')).toBe(true)
      expect(dirExists('B', 'A')).toBe(false)
      expect(listCanvases(db, VAULT_ID).find((c) => c.id === canvas.id)?.folder).toBe(deepest)
      expect(folderPaths()).toContain(deepest)
    })

    it('puts the directory back when the index write fails', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      createCanvas(db, vault, VAULT_ID, { title: 'Plan', folder: 'Work', scene: SCENE })

      // A real database failure, not a stub: every write now returns
      // SQLITE_READONLY, so the transaction throws after the directory moved.
      sqliteHandle.pragma('query_only = true')
      expect(() => renameCanvasFolder(db, vault, VAULT_ID, 'Work', 'Job')).toThrow()
      sqliteHandle.pragma('query_only = false')

      // The rows still say `Work`, so the directory has to be `Work`.
      expect(folderPaths()).toEqual(['Work'])
      expect(dirExists('Work', 'Plan.excalidraw')).toBe(true)
      expect(dirExists('Job')).toBe(false)
    })

    it("takes the folder's spelling from the row, not from the caller", () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      createCanvasFolder(db, vault, VAULT_ID, 'Work', 'Q3')
      const canvas = createCanvas(db, vault, VAULT_ID, { title: 'Plan', folder: 'Work/Q3' })

      // The id is NFC + lowercased, so `work/q3` resolves the row stored as
      // `Work/Q3` — but the parent it belongs under is the row's, not this
      // spelling. Rebuilding it from the caller silently re-cases the parent and
      // detaches the folder from the tree that is supposed to hold it (and, on a
      // case-sensitive filesystem, from its own directory).
      const renamed = renameCanvasFolder(db, vault, VAULT_ID, 'work/q3', 'Q4')

      expect(renamed?.path).toBe('Work/Q4')
      expect(folderPaths()).toEqual(['Work', 'Work/Q4'])
      expect(listCanvases(db, VAULT_ID).find((c) => c.id === canvas.id)?.folder).toBe('Work/Q4')
      expect(dirExists('Work', 'Q4', 'Plan.excalidraw')).toBe(true)
    })

    it('creates a child under the parent row, whatever case the caller used', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')

      const child = createCanvasFolder(db, vault, VAULT_ID, 'work', 'Q3')

      // Taking `work` at face value files the child under a second directory on
      // a case-sensitive filesystem, with the parent row pointing at the first.
      expect(child.path).toBe('Work/Q3')
      expect(folderPaths()).toEqual(['Work', 'Work/Q3'])
    })
  })

  describe('setCanvasFolderIcon', () => {
    it('sets and clears the icon', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')

      expect(setCanvasFolderIcon(db, VAULT_ID, 'Work', '🎨')?.icon).toBe('🎨')
      expect(listCanvasFolders(db, VAULT_ID)[0].icon).toBe('🎨')
      expect(setCanvasFolderIcon(db, VAULT_ID, 'Work', null)?.icon).toBeNull()
      expect(listCanvasFolders(db, VAULT_ID)[0].icon).toBeNull()
    })

    it('returns null for a folder that has no live row', () => {
      expect(setCanvasFolderIcon(db, VAULT_ID, 'Nope', '🎨')).toBeNull()
    })
  })

  describe('deleteCanvasFolder', () => {
    it('tombstones the folder, its descendants and every canvas inside', async () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      createCanvasFolder(db, vault, VAULT_ID, 'Work', 'Q3')
      const outer = createCanvas(db, vault, VAULT_ID, { title: 'Plan', folder: 'Work' })
      const inner = createCanvas(db, vault, VAULT_ID, { title: 'Deep', folder: 'Work/Q3' })

      const deleted = await deleteCanvasFolder(db, vault, VAULT_ID, 'Work', rmAsTrash)

      expect(deleted.sort()).toEqual([outer.id, inner.id].sort())
      expect(folderPaths()).toEqual([])
      expect(listCanvases(db, VAULT_ID)).toEqual([])
      expect(dirExists('Work')).toBe(false)
    })

    it('leaves a prefix-lookalike sibling alone', async () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      createCanvasFolder(db, vault, VAULT_ID, null, 'Workshop')
      const survivor = createCanvas(db, vault, VAULT_ID, { title: 'Bench', folder: 'Workshop' })

      const deleted = await deleteCanvasFolder(db, vault, VAULT_ID, 'Work', rmAsTrash)

      expect(deleted).toEqual([])
      expect(folderPaths()).toEqual(['Workshop'])
      expect(listCanvases(db, VAULT_ID).map((c) => c.id)).toEqual([survivor.id])
      expect(dirExists('Workshop')).toBe(true)
    })

    it('keeps the tombstones when trashing the directory fails', async () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      const canvas = createCanvas(db, vault, VAULT_ID, { title: 'Plan', folder: 'Work' })

      const deleted = await deleteCanvasFolder(db, vault, VAULT_ID, 'Work', async () => {
        throw new Error('trash unavailable')
      })

      // An fs failure must never roll back a tombstone — the row is the sync
      // truth, and resurrecting a deleted folder is worse than a stray directory.
      expect(deleted).toEqual([canvas.id])
      expect(folderPaths()).toEqual([])
      expect(listCanvases(db, VAULT_ID)).toEqual([])
    })
  })

  /**
   * Without these the folder rows are written locally and never leave the
   * device: the sync registry entry seeds once and then goes quiet forever.
   */
  describe('sync enqueues', () => {
    it('enqueues a create for a new folder', () => {
      const folder = createCanvasFolder(db, vault, VAULT_ID, null, 'Work')

      expect(syncMock.enqueueLocalSyncCreate).toHaveBeenCalledWith('canvas_folder', folder.id)
    })

    it('does not re-enqueue a folder that already exists', () => {
      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      syncMock.enqueueLocalSyncCreate.mockClear()

      createCanvasFolder(db, vault, VAULT_ID, null, 'Work')

      expect(syncMock.enqueueLocalSyncCreate).not.toHaveBeenCalled()
    })

    it('enqueues an update when the icon changes', () => {
      const folder = createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      syncMock.enqueueLocalSyncUpdate.mockClear()

      setCanvasFolderIcon(db, VAULT_ID, 'Work', '🎨')

      expect(syncMock.enqueueLocalSyncUpdate).toHaveBeenCalledWith('canvas_folder', folder.id)
    })

    it('enqueues the tombstone, the replacement and every moved canvas on a rename', () => {
      const before = createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      const canvas = createCanvas(db, vault, VAULT_ID, { title: 'Plan', folder: 'Work' })
      syncMock.enqueueLocalSyncCreate.mockClear()
      syncMock.enqueueLocalSyncUpdate.mockClear()
      syncMock.enqueueLocalSyncDelete.mockClear()

      const after = renameCanvasFolder(db, vault, VAULT_ID, 'Work', 'Studio')!

      expect(syncMock.enqueueLocalSyncUpdate).toHaveBeenCalledWith('canvas_folder', after.id)
      // The old path is a different derived id, so the peers have to be told it
      // is gone — otherwise the rename lands as a duplicate folder.
      expect(syncMock.enqueueLocalSyncDelete).toHaveBeenCalledWith(
        'canvas_folder',
        before.id,
        expect.stringContaining('Work')
      )
      // The canvas moved with the directory; its stored path changed.
      expect(syncMock.enqueueLocalSyncUpdate).toHaveBeenCalledWith('canvas', canvas.id)
    })

    it('never enqueues a delete for a case-only rename, which keeps the same id', () => {
      const before = createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      syncMock.enqueueLocalSyncDelete.mockClear()

      const after = renameCanvasFolder(db, vault, VAULT_ID, 'Work', 'work')!

      expect(after.id).toBe(before.id)
      expect(syncMock.enqueueLocalSyncDelete).not.toHaveBeenCalled()
      expect(syncMock.enqueueLocalSyncUpdate).toHaveBeenCalledWith('canvas_folder', after.id)
    })

    it('enqueues a delete for the folder, its descendants and every canvas inside', async () => {
      const work = createCanvasFolder(db, vault, VAULT_ID, null, 'Work')
      const q3 = createCanvasFolder(db, vault, VAULT_ID, 'Work', 'Q3')
      const canvas = createCanvas(db, vault, VAULT_ID, { title: 'Deep', folder: 'Work/Q3' })
      syncMock.enqueueLocalSyncDelete.mockClear()

      await deleteCanvasFolder(db, vault, VAULT_ID, 'Work', rmAsTrash)

      expect(syncMock.enqueueLocalSyncDelete).toHaveBeenCalledWith(
        'canvas_folder',
        work.id,
        expect.stringContaining('Work')
      )
      expect(syncMock.enqueueLocalSyncDelete).toHaveBeenCalledWith(
        'canvas_folder',
        q3.id,
        expect.any(String)
      )
      expect(syncMock.enqueueLocalSyncDelete).toHaveBeenCalledWith('canvas', canvas.id)
    })
  })
})
