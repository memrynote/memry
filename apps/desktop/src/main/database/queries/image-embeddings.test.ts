import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as sqliteVec from 'sqlite-vec'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import {
  cleanupTestDatabase,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { ensureVecImagesTable } from '../client'
import { EMBEDDING_DIMENSION } from '../../lib/embeddings-constants'
import {
  listImageEmbeddingState,
  nearestImageVectors,
  pruneOrphanImageEmbeddings,
  storeImageEmbedding
} from './image-embeddings'

const NOW = '2026-05-09T00:00:00.000Z'

const unit = (index: number): Float32Array => {
  const vector = new Float32Array(EMBEDDING_DIMENSION)
  vector[index] = 1
  return vector
}

describe('image embeddings storage', () => {
  let db: TestDatabaseResult

  beforeEach(() => {
    db = createTestIndexDb()
    sqliteVec.load(db.sqlite)
    ensureVecImagesTable(db.sqlite)
    db.db
      .insert(noteCache)
      .values({ id: 'n1', path: 'n1.md', title: 'n1', createdAt: NOW, modifiedAt: NOW })
      .run()
  })

  afterEach(() => {
    cleanupTestDatabase(db)
  })

  const image = (source: string, signature = '1:1') => ({
    noteId: 'n1',
    source,
    signature,
    path: `attachments/n1/${source}`,
    page: null,
    text: '',
    settled: true
  })

  it('finds the owning note of the nearest image, closest first', () => {
    storeImageEmbedding(db.sqlite, image('a.png'), unit(0), 1)
    storeImageEmbedding(db.sqlite, image('b.png'), unit(1), 1)

    const hits = nearestImageVectors(db.sqlite, unit(0), 5)

    expect(hits.map((hit) => hit.noteId)).toEqual(['n1', 'n1'])
    expect(hits[0].cosine).toBeCloseTo(1)
    expect(hits[1].cosine).toBeCloseTo(0)
  })

  it('replaces a vector and its state when an image is stored again', () => {
    storeImageEmbedding(db.sqlite, image('a.png', '1:1'), unit(0), 1)
    storeImageEmbedding(db.sqlite, image('a.png', '2:2'), unit(1), 1)

    expect(listImageEmbeddingState(db.db)).toEqual([
      { noteId: 'n1', source: 'a.png', signature: '2:2', inputVersion: 1 }
    ])
    expect(nearestImageVectors(db.sqlite, unit(1), 5)).toHaveLength(1)
  })

  it('prunes state whose vector is gone and vectors with no state', () => {
    storeImageEmbedding(db.sqlite, image('a.png'), unit(0), 1)
    db.sqlite.prepare("DELETE FROM vec_images WHERE image_key = 'n1/a.png'").run()
    db.sqlite
      .prepare('INSERT INTO vec_images (image_key, embedding) VALUES (?, ?)')
      .run('ghost/', unit(2))

    pruneOrphanImageEmbeddings(db.sqlite)

    expect(listImageEmbeddingState(db.db, 'n1')).toEqual([])
    expect(nearestImageVectors(db.sqlite, unit(2), 5)).toEqual([])
  })

  it('rebuilds a vec_images table of another width and forgets its state', () => {
    storeImageEmbedding(db.sqlite, image('a.png'), unit(0), 1)
    db.sqlite.exec('DROP TABLE vec_images')
    db.sqlite.exec(
      'CREATE VIRTUAL TABLE vec_images USING vec0(image_key TEXT PRIMARY KEY, embedding float[3] distance_metric=cosine)'
    )

    ensureVecImagesTable(db.sqlite)

    expect(listImageEmbeddingState(db.db)).toEqual([])
    storeImageEmbedding(db.sqlite, image('b.png'), unit(0), 1)
    expect(nearestImageVectors(db.sqlite, unit(0), 5)).toHaveLength(1)
  })
})
