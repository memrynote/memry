import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'

import * as schema from '@memry/db-schema/data-schema'
import { canvasFolderSyncId } from '@memry/contracts/canvas-folder-types'
import {
  createCanvas,
  deleteCanvas,
  duplicateCanvas,
  getCanvas,
  getCanvasFilePath,
  listCanvases,
  listCanvasesWithCounts,
  updateCanvas
} from './store'
import { CANVAS_DIR, readCanvasMeta } from './scene-file'
import { MAX_CANVAS_FOLDER_DEPTH } from './folder-paths'
import { hashesReferencedByOtherCanvases, listAssetsByCanvas } from './assets/asset-store'
import { planDereference } from './assets/dedup-plan'

const MIGRATIONS = [
  '0035_spatial_canvas.sql',
  '0036_canvas_assets.sql',
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

/**
 * The store normalizes what it writes (stable key order, explicit appState /
 * files), so a scene round-trips by content, not byte-for-byte. Two devices
 * therefore emit identical text for identical ink — which is what the sync
 * conflict-copy comparison depends on.
 */
function elementsOf(scene: string | undefined): unknown {
  return JSON.parse(scene ?? '{}').elements
}

/** Stand-in for `shell.trashItem`: the store must not care which it is. */
const unlinkAsTrash = async (absolutePath: string): Promise<void> => {
  fs.rmSync(absolutePath)
}

describe('canvas store', () => {
  let db: ReturnType<typeof freshDb>
  let vault: string

  beforeEach(() => {
    db = freshDb()
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-canvas-store-'))
  })

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true })
  })

  it('creates a canvas as a plain .excalidraw file in the vault', () => {
    const created = createCanvas(db, vault, 'vault-1', { title: 'Brain dump', scene: SCENE })

    expect(created.title).toBe('Brain dump')
    expect(elementsOf(created.scene)).toEqual([{ id: 'r1' }])

    const row = db.select().from(schema.canvases).all()[0]
    expect(row.filePath).toBe(`${CANVAS_DIR}/Brain dump.excalidraw`)
    // Nothing is encrypted at rest any more.
    expect(row.snapshotCiphertext).toBe('')

    const onDisk = fs.readFileSync(path.join(vault, row.filePath!), 'utf8')
    expect(JSON.parse(onDisk).elements).toEqual([{ id: 'r1' }])
    expect(readCanvasMeta(onDisk)?.id).toBe(created.id)
  })

  it('reads a canvas back with no key material whatsoever', () => {
    const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })

    const fetched = getCanvas(db, vault, created.id)
    expect(fetched?.id).toBe(created.id)
    expect(elementsOf(fetched?.scene)).toEqual([{ id: 'r1' }])
  })

  it('opens a canvas from a vault folder copied to another machine', () => {
    const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-canvas-copy-'))
    fs.cpSync(vault, copy, { recursive: true })

    try {
      // Same index rows, different machine, no keychain in sight.
      expect(elementsOf(getCanvas(db, copy, created.id)?.scene)).toEqual([{ id: 'r1' }])
    } finally {
      fs.rmSync(copy, { recursive: true, force: true })
    }
  })

  it('reports unreadable (never an empty scene) when the document is gone', () => {
    const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })
    const row = db.select().from(schema.canvases).all()[0]
    fs.rmSync(path.join(vault, row.filePath!))

    const fetched = getCanvas(db, vault, created.id)

    expect(fetched?.unreadable).toBe(true)
    expect(fetched?.scene).toBe('')
  })

  it('refuses to write over a row that has no document', () => {
    const created = createCanvas(db, vault, 'vault-1', { scene: SCENE })
    db.update(schema.canvases)
      .set({ filePath: null, snapshotCiphertext: 'legacy-ciphertext' })
      .where(eq(schema.canvases.id, created.id))
      .run()

    expect(updateCanvas(db, vault, created.id, { scene: 'v2' })).toEqual({
      ok: false,
      reason: 'not-found'
    })
    // The only copy of the ink is untouched.
    expect(db.select().from(schema.canvases).all()[0].snapshotCiphertext).toBe('legacy-ciphertext')
  })

  it('updates title/scene and rewrites entity refs as a set', () => {
    const created = createCanvas(db, vault, 'vault-1', { scene: SCENE })

    updateCanvas(db, vault, created.id, {
      entityRefs: [
        { entityType: 'note', entityId: 'n1' },
        { entityType: 'task', entityId: 't1' }
      ]
    })
    const nextScene = JSON.stringify({ type: 'excalidraw', version: 2, elements: [] })
    const summary = updateCanvas(db, vault, created.id, {
      title: 'Renamed',
      scene: nextScene,
      entityRefs: [{ entityType: 'note', entityId: 'n2' }]
    })

    expect(summary.ok && summary.summary.title).toBe('Renamed')
    expect(elementsOf(getCanvas(db, vault, created.id)?.scene)).toEqual([])

    const refs = db
      .select()
      .from(schema.canvasEntityRefs)
      .where(eq(schema.canvasEntityRefs.canvasId, created.id))
      .all()
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ entityType: 'note', entityId: 'n2' })
  })

  it('renames the file when the title changes, keeping the ink', () => {
    const created = createCanvas(db, vault, 'vault-1', { title: 'Old', scene: SCENE })

    updateCanvas(db, vault, created.id, { title: 'New' })

    const row = db.select().from(schema.canvases).all()[0]
    expect(row.filePath).toBe(`${CANVAS_DIR}/New.excalidraw`)
    expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Old.excalidraw'))).toBe(false)
    expect(elementsOf(getCanvas(db, vault, created.id)?.scene)).toEqual([{ id: 'r1' }])
  })

  it('gives two canvases with the same title two files', () => {
    createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })
    createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })

    const paths = db
      .select({ filePath: schema.canvases.filePath })
      .from(schema.canvases)
      .all()
      .map((row) => row.filePath)
    expect(new Set(paths).size).toBe(2)
  })

  it('reports not-found when updating a missing or deleted canvas', async () => {
    expect(updateCanvas(db, vault, 'nope', { title: 'x' })).toEqual({
      ok: false,
      reason: 'not-found'
    })
    const created = createCanvas(db, vault, 'vault-1', {})
    await deleteCanvas(db, vault, created.id, unlinkAsTrash)
    expect(updateCanvas(db, vault, created.id, { title: 'x' })).toEqual({
      ok: false,
      reason: 'not-found'
    })
  })

  it('rejects an update whose expectedUpdatedAt does not match the row', () => {
    const created = createCanvas(db, vault, 'vault-1', { title: 'A', scene: SCENE })

    const result = updateCanvas(db, vault, created.id, {
      scene: 'v2',
      expectedUpdatedAt: created.updatedAt - 1
    })

    expect(result).toEqual({ ok: false, reason: 'conflict' })
    expect(elementsOf(getCanvas(db, vault, created.id)?.scene)).toEqual([{ id: 'r1' }])
  })

  it('applies an update whose expectedUpdatedAt matches', () => {
    const created = createCanvas(db, vault, 'vault-1', { title: 'A', scene: SCENE })

    const result = updateCanvas(db, vault, created.id, {
      scene: 'v2',
      expectedUpdatedAt: created.updatedAt
    })

    expect(result.ok).toBe(true)
    expect(elementsOf(getCanvas(db, vault, created.id)?.scene)).toEqual([])
  })

  it('applies an update with no expectedUpdatedAt (unchanged legacy behaviour)', () => {
    const created = createCanvas(db, vault, 'vault-1', { title: 'A', scene: SCENE })

    const result = updateCanvas(db, vault, created.id, { scene: 'v2' })

    expect(result).toEqual({ ok: true, summary: expect.objectContaining({ id: created.id }) })
    expect(elementsOf(getCanvas(db, vault, created.id)?.scene)).toEqual([])
  })

  it('lists canvases with their entity-ref counts', () => {
    const a = createCanvas(db, vault, 'vault-1', { title: 'A' })
    const b = createCanvas(db, vault, 'vault-1', { title: 'B' })
    updateCanvas(db, vault, a.id, {
      entityRefs: [
        { entityType: 'note', entityId: 'n1' },
        { entityType: 'task', entityId: 't1' }
      ]
    })

    const listed = listCanvasesWithCounts(db, 'vault-1')

    expect(listed.find((c) => c.id === a.id)?.itemCount).toBe(2)
    expect(listed.find((c) => c.id === b.id)?.itemCount).toBe(0)
  })

  it('soft-deletes: tombstones the row, removes the file, prunes refs', async () => {
    const created = createCanvas(db, vault, 'vault-1', { scene: SCENE })
    updateCanvas(db, vault, created.id, {
      entityRefs: [{ entityType: 'calendar_event', entityId: 'e1' }]
    })
    const filePath = db.select().from(schema.canvases).all()[0].filePath!

    expect(await deleteCanvas(db, vault, created.id, unlinkAsTrash)).toBe(true)
    expect(await deleteCanvas(db, vault, created.id, unlinkAsTrash)).toBe(false)

    const raw = db.select().from(schema.canvases).all()
    expect(raw).toHaveLength(1)
    expect(raw[0].deletedAt).not.toBeNull()
    expect(fs.existsSync(path.join(vault, filePath))).toBe(false)

    expect(getCanvas(db, vault, created.id)).toBeNull()
    expect(listCanvases(db, 'vault-1')).toHaveLength(0)
    expect(db.select().from(schema.canvasEntityRefs).all()).toHaveLength(0)
  })

  it('lists only the vault-scoped, non-deleted canvases', async () => {
    const a = createCanvas(db, vault, 'vault-1', { title: 'A' })
    createCanvas(db, vault, 'vault-2', { title: 'B' })
    const c = createCanvas(db, vault, 'vault-1', { title: 'C' })
    await deleteCanvas(db, vault, c.id, unlinkAsTrash)

    const listed = listCanvases(db, 'vault-1')
    expect(listed.map((x) => x.id)).toEqual([a.id])
  })

  describe('canvas folders', () => {
    it('creates a canvas inside a folder', () => {
      const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', folder: 'Work' })

      expect(created.folder).toBe('Work')
      expect(db.select().from(schema.canvases).all()[0].filePath).toBe(
        `${CANVAS_DIR}/Work/Plan.excalidraw`
      )
      expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work', 'Plan.excalidraw'))).toBe(true)
    })

    it('stores the folder that exists on disk, not the one that was asked for', () => {
      // `CON` is a reserved Windows device name, so the directory that actually
      // gets created is `CON canvas`. A row holding `CON` would point the index
      // at a directory that does not exist.
      const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', folder: 'CON' })

      expect(created.folder).toBe('CON canvas')
      expect(db.select().from(schema.canvases).all()[0].folder).toBe('CON canvas')
      expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'CON canvas', 'Plan.excalidraw'))).toBe(
        true
      )
    })

    it('moves the file when the folder changes', () => {
      const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })

      const result = updateCanvas(db, vault, created.id, { folder: 'Work' })

      expect(result.ok && result.summary.folder).toBe('Work')
      expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Plan.excalidraw'))).toBe(false)
      expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work', 'Plan.excalidraw'))).toBe(true)
      expect(db.select().from(schema.canvases).all()[0].folder).toBe('Work')
    })

    it('keeps the ink when a canvas moves', () => {
      const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })

      updateCanvas(db, vault, created.id, { folder: 'Work' })

      const moved = getCanvas(db, vault, created.id)
      expect(moved?.unreadable).toBeFalsy()
      expect(elementsOf(moved?.scene)).toEqual([{ id: 'r1' }])
    })

    it('moves a canvas back to the root', () => {
      const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', folder: 'Work' })

      const result = updateCanvas(db, vault, created.id, { folder: null })

      expect(result.ok && result.summary.folder).toBeNull()
      expect(db.select().from(schema.canvases).all()[0].folder).toBeNull()
      expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Plan.excalidraw'))).toBe(true)
    })

    it('renames inside the folder when only the title changes', () => {
      const created = createCanvas(db, vault, 'vault-1', { title: 'Old', folder: 'Work' })

      updateCanvas(db, vault, created.id, { title: 'New' })

      const row = db.select().from(schema.canvases).all()[0]
      expect(row.filePath).toBe(`${CANVAS_DIR}/Work/New.excalidraw`)
      expect(row.folder).toBe('Work')
    })

    it('uniquifies the title with the file when a move collides', () => {
      // The file is uniquified per folder, so the label has to follow it. Two
      // live rows titled `Plan` in one folder are indistinguishable in the
      // sidebar, and an agent asking for `Work/Plan` is told the name is
      // ambiguous and handed two identical candidates.
      const settled = createCanvas(db, vault, 'vault-1', { title: 'Plan', folder: 'Work' })
      const moving = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })

      const result = updateCanvas(db, vault, moving.id, { folder: 'Work' })

      expect(result.ok && result.summary.title).toBe('Plan 2')
      const row = db.select().from(schema.canvases).where(eq(schema.canvases.id, moving.id)).get()!
      expect(row.title).toBe('Plan 2')
      expect(row.filePath).toBe(`${CANVAS_DIR}/Work/Plan 2.excalidraw`)
      // The canvas that was already there keeps its name and its ink.
      expect(listCanvases(db, 'vault-1').find((c) => c.id === settled.id)?.title).toBe('Plan')
      expect(elementsOf(getCanvas(db, vault, moving.id)?.scene)).toEqual([{ id: 'r1' }])
    })

    it('leaves an untitled canvas untitled when its move collides', () => {
      createCanvas(db, vault, 'vault-1', { title: null, folder: 'Work' })
      const moving = createCanvas(db, vault, 'vault-1', { title: null })

      const result = updateCanvas(db, vault, moving.id, { folder: 'Work' })

      expect(result.ok && result.summary.title).toBeNull()
      expect(
        db.select().from(schema.canvases).where(eq(schema.canvases.id, moving.id)).get()!.title
      ).toBeNull()
    })

    it('keeps the title the user typed when the rename fails', () => {
      const created = createCanvas(db, vault, 'vault-1', { title: 'Old', folder: 'Work' })
      fs.rmSync(path.join(vault, CANVAS_DIR, 'Work', 'Old.excalidraw'))

      const result = updateCanvas(db, vault, created.id, { title: 'New' })

      expect(result.ok && result.summary.title).toBe('New')
      expect(db.select().from(schema.canvases).all()[0].filePath).toBe(
        `${CANVAS_DIR}/Work/Old.excalidraw`
      )
    })

    it('leaves placement alone when the update omits folder', () => {
      const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', folder: 'Work' })

      updateCanvas(db, vault, created.id, { scene: SCENE })

      const row = db.select().from(schema.canvases).all()[0]
      expect(row.folder).toBe('Work')
      expect(row.filePath).toBe(`${CANVAS_DIR}/Work/Plan.excalidraw`)
    })

    it('keeps the stored folder describing where the file IS when the move fails', () => {
      const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })
      // The document vanished from under us (moved away in Finder, or a cloud
      // client mid-sync): the rename fails and the path stays where it was.
      fs.rmSync(path.join(vault, CANVAS_DIR, 'Plan.excalidraw'))

      const result = updateCanvas(db, vault, created.id, { folder: 'Work' })

      expect(result.ok).toBe(true)
      const row = db.select().from(schema.canvases).all()[0]
      expect(row.filePath).toBe(`${CANVAS_DIR}/Plan.excalidraw`)
      expect(row.folder).toBeNull()
      expect(result.ok && result.summary.folder).toBeNull()
    })

    it('stores an icon and returns it everywhere a canvas is listed', () => {
      const created = createCanvas(db, vault, 'vault-1', { title: 'Plan' })

      const result = updateCanvas(db, vault, created.id, { icon: '🎨' })

      expect(result.ok && result.summary.icon).toBe('🎨')
      expect(listCanvases(db, 'vault-1')[0].icon).toBe('🎨')
      expect(listCanvasesWithCounts(db, 'vault-1')[0].icon).toBe('🎨')
      expect(getCanvas(db, vault, created.id)?.icon).toBe('🎨')
    })

    /**
     * A row can hold a folder deeper than the cap: another device wrote it, or a
     * future version raised the cap and synced. The depth guard is a
     * CONSTRUCTION rule, so running it over a row we did not choose turns
     * "filed too deep" into "cannot be opened, edited, or rescued".
     */
    describe('a row stored past the depth cap', () => {
      const DEEP = Array.from({ length: MAX_CANVAS_FOLDER_DEPTH + 1 }, (_, i) => `d${i + 1}`).join(
        '/'
      )

      /** Seeds a canvas whose row and file both sit one level past the cap. */
      const seedDeepCanvas = (): string => {
        const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })
        const deepDir = path.join(vault, CANVAS_DIR, ...DEEP.split('/'))
        fs.mkdirSync(deepDir, { recursive: true })
        fs.renameSync(
          path.join(vault, CANVAS_DIR, 'Plan.excalidraw'),
          path.join(deepDir, 'Plan.excalidraw')
        )
        db.update(schema.canvases)
          .set({ folder: DEEP, filePath: `${CANVAS_DIR}/${DEEP}/Plan.excalidraw` })
          .where(eq(schema.canvases.id, created.id))
          .run()
        return created.id
      }

      it('still saves the ink', () => {
        const id = seedDeepCanvas()
        const nextScene = JSON.stringify({ type: 'excalidraw', version: 2, elements: [] })

        // The autosave path. Refusing it here does not un-nest anything; it just
        // throws away whatever the user drew.
        expect(updateCanvas(db, vault, id, { scene: nextScene }).ok).toBe(true)
        expect(elementsOf(getCanvas(db, vault, id)?.scene)).toEqual([])
        expect(db.select().from(schema.canvases).all()[0].folder).toBe(DEEP)
      })

      it('lets the user move it back out', () => {
        const id = seedDeepCanvas()

        const result = updateCanvas(db, vault, id, { folder: null })

        expect(result.ok && result.summary.folder).toBeNull()
        expect(db.select().from(schema.canvases).all()[0].filePath).toBe(
          `${CANVAS_DIR}/Plan.excalidraw`
        )
        expect(elementsOf(getCanvas(db, vault, id)?.scene)).toEqual([{ id: 'r1' }])
      })
    })

    /**
     * The settled invariant: the folder a canvas row STORES is the one the
     * index already uses for that directory — the live `canvas_folders` row's
     * spelling when there is one, the on-disk-canonical form otherwise. Both
     * canvas stores go through the same helper, so a canvas and the folder it
     * sits in can never name that directory two different ways.
     */
    describe('the stored folder is the one the index holds, never the caller spelling', () => {
      /** A folder row exactly as `createCanvasFolder` would leave it. */
      const seedFolderRow = (folderPath: string): void => {
        fs.mkdirSync(path.join(vault, CANVAS_DIR, ...folderPath.split('/')), { recursive: true })
        db.insert(schema.canvasFolders)
          .values({
            id: canvasFolderSyncId(folderPath),
            vaultId: 'vault-1',
            path: folderPath,
            icon: null,
            createdAt: 1,
            updatedAt: 1,
            deletedAt: null,
            clock: null
          })
          .run()
      }

      const storedFolder = (): string | null =>
        db.select().from(schema.canvases).all()[0].folder ?? null

      it('takes the row casing when a move asks for a differently-cased folder', () => {
        // The id is NFC + lowercase, so `work` addresses the row stored as
        // `Work`. Storing `work` would leave the canvas naming a directory that
        // only exists on a case-sensitive filesystem — a second `canvases/work`
        // on Linux, with no folder row pointing at it.
        seedFolderRow('Work')
        const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })

        const result = updateCanvas(db, vault, created.id, { folder: 'work' })

        expect(result.ok && result.summary.folder).toBe('Work')
        expect(storedFolder()).toBe('Work')
        expect(db.select().from(schema.canvases).all()[0].filePath).toBe(
          `${CANVAS_DIR}/Work/Plan.excalidraw`
        )
      })

      it('takes the row casing when a canvas is CREATED in a differently-cased folder', () => {
        seedFolderRow('Work')

        const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', folder: 'work' })

        expect(created.folder).toBe('Work')
        expect(storedFolder()).toBe('Work')
        expect(db.select().from(schema.canvases).all()[0].filePath).toBe(
          `${CANVAS_DIR}/Work/Plan.excalidraw`
        )
      })

      it('canonicalizes a Windows-reserved folder on a move', () => {
        const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })

        const result = updateCanvas(db, vault, created.id, { folder: 'CON' })

        expect(result.ok && result.summary.folder).toBe('CON canvas')
        expect(storedFolder()).toBe('CON canvas')
        expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'CON canvas', 'Plan.excalidraw'))).toBe(
          true
        )
      })

      it('canonicalizes trailing dots and spaces on a move', () => {
        // Win32 silently trims both, so `Work.` and `Work ` resolve to `Work`
        // there — a row holding either would miss the directory on Windows.
        for (const asked of ['Work.', 'Work ']) {
          const created = createCanvas(db, vault, 'vault-1', { title: asked, scene: SCENE })

          const result = updateCanvas(db, vault, created.id, { folder: asked })

          expect(result.ok && result.summary.folder).toBe('Work')
          expect(
            db
              .select()
              .from(schema.canvases)
              .all()
              .find((row) => row.id === created.id)?.folder
          ).toBe('Work')
        }
        expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work'))).toBe(true)
      })

      it('keeps a no-op move on the spelling already stored', () => {
        seedFolderRow('Work')
        const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', folder: 'Work' })

        const result = updateCanvas(db, vault, created.id, { folder: 'Work' })

        expect(result.ok && result.summary.folder).toBe('Work')
        expect(storedFolder()).toBe('Work')
      })
    })

    it('clears an icon when the update passes null', () => {
      const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', icon: '🎨' })
      expect(created.icon).toBe('🎨')

      updateCanvas(db, vault, created.id, { icon: null })

      expect(listCanvases(db, 'vault-1')[0].icon).toBeNull()
    })
  })

  describe('duplicateCanvas', () => {
    it('copies the scene into a new canvas beside the original', () => {
      const original = createCanvas(db, vault, 'vault-1', {
        title: 'Plan',
        folder: 'Work',
        icon: '🎨',
        scene: SCENE
      })

      const copy = duplicateCanvas(db, vault, 'vault-1', original.id)

      expect(copy).not.toBeNull()
      expect(copy!.id).not.toBe(original.id)
      expect(copy!.title).toBe('Plan 2')
      expect(copy!.folder).toBe('Work')
      expect(copy!.icon).toBe('🎨')
      expect(elementsOf(copy!.scene)).toEqual([{ id: 'r1' }])
      expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Work', 'Plan 2.excalidraw'))).toBe(true)
      // The original is untouched.
      expect(elementsOf(getCanvas(db, vault, original.id)?.scene)).toEqual([{ id: 'r1' }])
    })

    it('refuses to duplicate a canvas whose document cannot be read', () => {
      const original = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })
      fs.rmSync(path.join(vault, CANVAS_DIR, 'Plan.excalidraw'))

      expect(duplicateCanvas(db, vault, 'vault-1', original.id)).toBeNull()
      // No empty canvas wearing the original's name.
      expect(listCanvases(db, 'vault-1')).toHaveLength(1)
    })

    it('returns null for a missing or tombstoned canvas', async () => {
      expect(duplicateCanvas(db, vault, 'vault-1', 'nope')).toBeNull()
      const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })
      // A trash that leaves the document where it is, so what stops the
      // duplicate here is the TOMBSTONE and not an unreadable file.
      await deleteCanvas(db, vault, created.id, async () => {})
      expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Plan.excalidraw'))).toBe(true)

      expect(duplicateCanvas(db, vault, 'vault-1', created.id)).toBeNull()
    })

    it('copies the canvas_assets rows', () => {
      const original = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })
      db.insert(schema.canvasAssets)
        .values({
          vaultId: 'vault-1',
          canvasId: original.id,
          contentHash: 'hash1',
          attachmentId: 'a1',
          fileId: 'f1',
          filename: 'hash1.png',
          mimeType: 'image/png',
          sizeBytes: 10,
          chunkHashes: ['c1'],
          createdAt: Date.now()
        })
        .run()

      const copy = duplicateCanvas(db, vault, 'vault-1', original.id)

      const copied = listAssetsByCanvas(db, copy!.id)
      expect(copied).toHaveLength(1)
      expect(copied[0].contentHash).toBe('hash1')
      expect(copied[0].chunkHashes).toEqual(['c1'])
      expect(copied[0].vaultId).toBe('vault-1')
    })

    it('leaves the copy intact when the ORIGINAL is later saved without the image', () => {
      // The regression that matters: asset GC reaps a contentHash when no OTHER
      // canvas references it. A duplicate whose scene shows the image but whose
      // canvas_assets rows are missing would make the original's next save
      // dereference those chunks on the server — breaking the copy silently.
      const original = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })
      db.insert(schema.canvasAssets)
        .values({
          vaultId: 'vault-1',
          canvasId: original.id,
          contentHash: 'hash1',
          attachmentId: 'a1',
          fileId: 'f1',
          filename: 'hash1.png',
          mimeType: 'image/png',
          sizeBytes: 10,
          chunkHashes: ['c1'],
          createdAt: Date.now()
        })
        .run()

      duplicateCanvas(db, vault, 'vault-1', original.id)

      // What reconcileCanvasAssets computes when the original is saved with a
      // scene that no longer shows the image.
      const plan = planDereference(
        listAssetsByCanvas(db, original.id),
        new Set(),
        hashesReferencedByOtherCanvases(db, 'vault-1', original.id)
      )

      expect(plan.removedContentHashes).toEqual(['hash1'])
      expect(plan.dereferencedContentHashes).toEqual([])
      expect(plan.dereferenceChunkHashes).toEqual([])
    })
  })

  describe('deleteCanvas', () => {
    it('sends the file to the trash instead of unlinking it', async () => {
      const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })
      const trashed: string[] = []

      const ok = await deleteCanvas(db, vault, created.id, async (abs) => {
        trashed.push(abs)
      })

      expect(ok).toBe(true)
      expect(trashed).toEqual([path.join(vault, CANVAS_DIR, 'Plan.excalidraw')])
      expect(getCanvas(db, vault, created.id)).toBeNull()
    })

    it('still tombstones the row, and unlinks, when trashing fails', async () => {
      const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })

      const ok = await deleteCanvas(db, vault, created.id, async () => {
        throw new Error('trash unavailable')
      })

      expect(ok).toBe(true)
      expect(getCanvas(db, vault, created.id)).toBeNull()
      expect(db.select().from(schema.canvases).all()[0].deletedAt).not.toBeNull()
      // Fallback: a deleted canvas must not keep haunting the vault folder.
      expect(fs.existsSync(path.join(vault, CANVAS_DIR, 'Plan.excalidraw'))).toBe(false)
    })
  })

  describe('getCanvasFilePath', () => {
    it('returns the vault-relative path of a live canvas', () => {
      const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', folder: 'Work' })

      expect(getCanvasFilePath(db, created.id)).toBe(`${CANVAS_DIR}/Work/Plan.excalidraw`)
    })

    it('returns null for a missing or tombstoned canvas', async () => {
      expect(getCanvasFilePath(db, 'nope')).toBeNull()
      const created = createCanvas(db, vault, 'vault-1', { title: 'Plan' })
      await deleteCanvas(db, vault, created.id, unlinkAsTrash)
      expect(getCanvasFilePath(db, created.id)).toBeNull()
    })
  })
})
