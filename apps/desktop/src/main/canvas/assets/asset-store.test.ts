import { describe, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import type { NewCanvasAssetRow } from '@memry/db-schema'
import {
  deleteCanvasAssetRows,
  findAssetByContentHash,
  hashesReferencedByOtherCanvases,
  listAssetsByCanvas,
  recordAsset
} from './asset-store'

const MIGRATION_FILES = [
  '0035_spatial_canvas.sql',
  '0036_canvas_assets.sql',
  '0045_canvas_files.sql'
]

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  for (const file of MIGRATION_FILES) {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', '..', 'database', 'drizzle-data', file),
      'utf8'
    )
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) sqlite.exec(trimmed)
    }
  }
  return drizzle(sqlite, { schema })
}

function insertCanvas(db: ReturnType<typeof freshDb>, id: string, vaultId: string) {
  db.insert(schema.canvases)
    .values({
      id,
      vaultId,
      title: null,
      snapshotCiphertext: 'ciphertext',
      vectorClock: {},
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      deletedAt: null,
      lastSyncedAt: null,
      clock: null
    })
    .run()
}

function assetRow(overrides: Partial<NewCanvasAssetRow> = {}): NewCanvasAssetRow {
  return {
    vaultId: 'vault-1',
    canvasId: 'canvas-a',
    contentHash: 'hash-x',
    attachmentId: 'attachment-1',
    fileId: 'file-1',
    filename: 'image.png',
    mimeType: 'image/png',
    sizeBytes: 1234,
    chunkHashes: ['chunk-1'],
    createdAt: 1700000000000,
    ...overrides
  }
}

describe('canvas asset store', () => {
  let db: ReturnType<typeof freshDb>

  beforeEach(() => {
    db = freshDb()
    insertCanvas(db, 'canvas-a', 'vault-1')
    insertCanvas(db, 'canvas-b', 'vault-1')
    insertCanvas(db, 'canvas-other-vault', 'vault-2')
  })

  describe('findAssetByContentHash', () => {
    it('finds a recorded row by (vaultId, contentHash)', () => {
      recordAsset(db, assetRow({ contentHash: 'hash-x' }))
      const found = findAssetByContentHash(db, 'vault-1', 'hash-x')
      expect(found?.contentHash).toBe('hash-x')
      expect(found?.canvasId).toBe('canvas-a')
    })

    it('returns undefined for an unknown hash', () => {
      expect(findAssetByContentHash(db, 'vault-1', 'no-such-hash')).toBeUndefined()
    })

    it('is scoped by vaultId', () => {
      recordAsset(
        db,
        assetRow({ canvasId: 'canvas-other-vault', vaultId: 'vault-2', contentHash: 'hash-x' })
      )
      expect(findAssetByContentHash(db, 'vault-1', 'hash-x')).toBeUndefined()
      expect(findAssetByContentHash(db, 'vault-2', 'hash-x')?.canvasId).toBe('canvas-other-vault')
    })
  })

  describe('recordAsset', () => {
    it('upsert is idempotent: recording the same (canvasId, contentHash) twice yields one row', () => {
      recordAsset(db, assetRow({ contentHash: 'hash-x' }))
      recordAsset(db, assetRow({ contentHash: 'hash-x' }))

      const rows = db.select().from(schema.canvasAssets).all()
      expect(rows).toHaveLength(1)
    })
  })

  describe('listAssetsByCanvas', () => {
    it('returns only that canvas rows', () => {
      recordAsset(db, assetRow({ canvasId: 'canvas-a', contentHash: 'hash-x' }))
      recordAsset(db, assetRow({ canvasId: 'canvas-b', contentHash: 'hash-y' }))

      const rows = listAssetsByCanvas(db, 'canvas-a')
      expect(rows.map((r) => r.contentHash)).toEqual(['hash-x'])
    })
  })

  describe('hashesReferencedByOtherCanvases', () => {
    it('returns hashes referenced by other canvases, excluding the given canvasId own hashes', () => {
      recordAsset(db, assetRow({ canvasId: 'canvas-a', contentHash: 'hash-x' }))
      recordAsset(db, assetRow({ canvasId: 'canvas-b', contentHash: 'hash-x' }))
      recordAsset(db, assetRow({ canvasId: 'canvas-b', contentHash: 'hash-y' }))

      const forA = hashesReferencedByOtherCanvases(db, 'vault-1', 'canvas-a')
      expect(forA).toEqual(new Set(['hash-x', 'hash-y']))

      const forB = hashesReferencedByOtherCanvases(db, 'vault-1', 'canvas-b')
      expect(forB).toEqual(new Set(['hash-x']))
    })
  })

  describe('deleteCanvasAssetRows', () => {
    it('removes only the named (canvasId, contentHash) rows, leaving other canvases rows intact', () => {
      recordAsset(db, assetRow({ canvasId: 'canvas-a', contentHash: 'hash-x' }))
      recordAsset(db, assetRow({ canvasId: 'canvas-a', contentHash: 'hash-y' }))
      recordAsset(db, assetRow({ canvasId: 'canvas-b', contentHash: 'hash-x' }))

      deleteCanvasAssetRows(db, 'canvas-a', ['hash-x'])

      expect(listAssetsByCanvas(db, 'canvas-a').map((r) => r.contentHash)).toEqual(['hash-y'])
      expect(listAssetsByCanvas(db, 'canvas-b').map((r) => r.contentHash)).toEqual(['hash-x'])
    })

    it('is a no-op for an empty list', () => {
      recordAsset(db, assetRow({ canvasId: 'canvas-a', contentHash: 'hash-x' }))
      deleteCanvasAssetRows(db, 'canvas-a', [])
      expect(listAssetsByCanvas(db, 'canvas-a')).toHaveLength(1)
    })
  })
})
