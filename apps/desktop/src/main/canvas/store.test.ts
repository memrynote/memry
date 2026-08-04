import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'

import * as schema from '@memry/db-schema/data-schema'
import {
  createCanvas,
  deleteCanvas,
  getCanvas,
  listCanvases,
  listCanvasesWithCounts,
  updateCanvas
} from './store'
import { CANVAS_DIR, readCanvasMeta } from './scene-file'

const MIGRATIONS = ['0035_spatial_canvas.sql', '0045_canvas_files.sql']

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

  it('reports not-found when updating a missing or deleted canvas', () => {
    expect(updateCanvas(db, vault, 'nope', { title: 'x' })).toEqual({
      ok: false,
      reason: 'not-found'
    })
    const created = createCanvas(db, vault, 'vault-1', {})
    deleteCanvas(db, vault, created.id)
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

  it('soft-deletes: tombstones the row, removes the file, prunes refs', () => {
    const created = createCanvas(db, vault, 'vault-1', { scene: SCENE })
    updateCanvas(db, vault, created.id, {
      entityRefs: [{ entityType: 'calendar_event', entityId: 'e1' }]
    })
    const filePath = db.select().from(schema.canvases).all()[0].filePath!

    expect(deleteCanvas(db, vault, created.id)).toBe(true)
    expect(deleteCanvas(db, vault, created.id)).toBe(false)

    const raw = db.select().from(schema.canvases).all()
    expect(raw).toHaveLength(1)
    expect(raw[0].deletedAt).not.toBeNull()
    expect(fs.existsSync(path.join(vault, filePath))).toBe(false)

    expect(getCanvas(db, vault, created.id)).toBeNull()
    expect(listCanvases(db, 'vault-1')).toHaveLength(0)
    expect(db.select().from(schema.canvasEntityRefs).all()).toHaveLength(0)
  })

  it('lists only the vault-scoped, non-deleted canvases', () => {
    const a = createCanvas(db, vault, 'vault-1', { title: 'A' })
    createCanvas(db, vault, 'vault-2', { title: 'B' })
    const c = createCanvas(db, vault, 'vault-1', { title: 'C' })
    deleteCanvas(db, vault, c.id)

    const listed = listCanvases(db, 'vault-1')
    expect(listed.map((x) => x.id)).toEqual([a.id])
  })
})
