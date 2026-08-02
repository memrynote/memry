import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import sodium from 'libsodium-wrappers-sumo'

import * as schema from '@memry/db-schema/data-schema'
import {
  createCanvas,
  deleteCanvas,
  getCanvas,
  listCanvases,
  listCanvasesWithCounts,
  updateCanvas
} from './store'
import { decryptCanvasSceneForVault } from './encryption'

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'database', 'drizzle-data', '0035_spatial_canvas.sql'),
  'utf8'
)

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  for (const statement of MIGRATION_SQL.split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (trimmed) sqlite.exec(trimmed)
  }
  return drizzle(sqlite, { schema })
}

const SCENE = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'r1' }] })

describe('canvas store', () => {
  let vaultKey: Uint8Array
  let db: ReturnType<typeof freshDb>

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  beforeEach(() => {
    db = freshDb()
  })

  it('creates a canvas with an encrypted scene and reads it back', () => {
    const created = createCanvas(db, vaultKey, 'vault-1', { title: 'Brain dump', scene: SCENE })

    expect(created.id).toBeTruthy()
    expect(created.title).toBe('Brain dump')
    expect(created.scene).toBe(SCENE)

    const raw = db.select().from(schema.canvases).all()[0]
    expect(raw.snapshotCiphertext).not.toContain('excalidraw')
    expect(raw.clock).toBeNull()
    expect(decryptCanvasSceneForVault(raw.snapshotCiphertext, vaultKey)).toBe(SCENE)

    const fetched = getCanvas(db, vaultKey, created.id)
    expect(fetched).toEqual(created)
  })

  it('fails to decrypt with a different vault key', () => {
    const created = createCanvas(db, vaultKey, 'vault-1', { scene: SCENE })
    const otherKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
    expect(() => getCanvas(db, otherKey, created.id)).toThrow()
  })

  it('updates title/scene and rewrites entity refs as a set', () => {
    const created = createCanvas(db, vaultKey, 'vault-1', { scene: SCENE })

    updateCanvas(db, vaultKey, created.id, {
      entityRefs: [
        { entityType: 'note', entityId: 'n1' },
        { entityType: 'task', entityId: 't1' }
      ]
    })
    const nextScene = JSON.stringify({ type: 'excalidraw', version: 2, elements: [] })
    const summary = updateCanvas(db, vaultKey, created.id, {
      title: 'Renamed',
      scene: nextScene,
      entityRefs: [{ entityType: 'note', entityId: 'n2' }]
    })

    expect(summary.ok && summary.summary.title).toBe('Renamed')
    const fetched = getCanvas(db, vaultKey, created.id)
    expect(fetched?.scene).toBe(nextScene)

    const refs = db
      .select()
      .from(schema.canvasEntityRefs)
      .where(eq(schema.canvasEntityRefs.canvasId, created.id))
      .all()
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ entityType: 'note', entityId: 'n2' })
  })

  it('reports not-found when updating a missing or deleted canvas', () => {
    expect(updateCanvas(db, vaultKey, 'nope', { title: 'x' })).toEqual({
      ok: false,
      reason: 'not-found'
    })
    const created = createCanvas(db, vaultKey, 'vault-1', {})
    deleteCanvas(db, created.id)
    expect(updateCanvas(db, vaultKey, created.id, { title: 'x' })).toEqual({
      ok: false,
      reason: 'not-found'
    })
  })

  it('rejects an update whose expectedUpdatedAt does not match the row', () => {
    const created = createCanvas(db, vaultKey, 'vault-1', { title: 'A', scene: SCENE })

    const result = updateCanvas(db, vaultKey, created.id, {
      scene: 'v2',
      expectedUpdatedAt: created.updatedAt - 1
    })

    expect(result).toEqual({ ok: false, reason: 'conflict' })
    expect(getCanvas(db, vaultKey, created.id)?.scene).toBe(SCENE)
  })

  it('applies an update whose expectedUpdatedAt matches', () => {
    const created = createCanvas(db, vaultKey, 'vault-1', { title: 'A', scene: SCENE })

    const result = updateCanvas(db, vaultKey, created.id, {
      scene: 'v2',
      expectedUpdatedAt: created.updatedAt
    })

    expect(result.ok).toBe(true)
    expect(getCanvas(db, vaultKey, created.id)?.scene).toBe('v2')
  })

  it('applies an update with no expectedUpdatedAt (unchanged legacy behaviour)', () => {
    const created = createCanvas(db, vaultKey, 'vault-1', { title: 'A', scene: SCENE })

    const result = updateCanvas(db, vaultKey, created.id, { scene: 'v2' })

    expect(result).toEqual({ ok: true, summary: expect.objectContaining({ id: created.id }) })
    expect(getCanvas(db, vaultKey, created.id)?.scene).toBe('v2')
  })

  it('lists canvases with their entity-ref counts', () => {
    const a = createCanvas(db, vaultKey, 'vault-1', { title: 'A' })
    const b = createCanvas(db, vaultKey, 'vault-1', { title: 'B' })
    updateCanvas(db, vaultKey, a.id, {
      entityRefs: [
        { entityType: 'note', entityId: 'n1' },
        { entityType: 'task', entityId: 't1' }
      ]
    })

    const listed = listCanvasesWithCounts(db, 'vault-1')

    expect(listed.find((c) => c.id === a.id)?.itemCount).toBe(2)
    expect(listed.find((c) => c.id === b.id)?.itemCount).toBe(0)
  })

  it('soft-deletes: tombstones the row, hides it from get/list, prunes refs', () => {
    const created = createCanvas(db, vaultKey, 'vault-1', { scene: SCENE })
    updateCanvas(db, vaultKey, created.id, {
      entityRefs: [{ entityType: 'calendar_event', entityId: 'e1' }]
    })

    expect(deleteCanvas(db, created.id)).toBe(true)
    expect(deleteCanvas(db, created.id)).toBe(false)

    const raw = db.select().from(schema.canvases).all()
    expect(raw).toHaveLength(1)
    expect(raw[0].deletedAt).not.toBeNull()

    expect(getCanvas(db, vaultKey, created.id)).toBeNull()
    expect(listCanvases(db, 'vault-1')).toHaveLength(0)
    expect(db.select().from(schema.canvasEntityRefs).all()).toHaveLength(0)
  })

  it('lists only the vault-scoped, non-deleted canvases', () => {
    const a = createCanvas(db, vaultKey, 'vault-1', { title: 'A' })
    createCanvas(db, vaultKey, 'vault-2', { title: 'B' })
    const c = createCanvas(db, vaultKey, 'vault-1', { title: 'C' })
    deleteCanvas(db, c.id)

    const listed = listCanvases(db, 'vault-1')
    expect(listed.map((x) => x.id)).toEqual([a.id])
  })
})
