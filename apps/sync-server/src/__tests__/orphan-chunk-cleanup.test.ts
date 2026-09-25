import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cleanupOrphanedBlobChunks } from '../services/cleanup'
import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'

const USER_ID = 'user-1'

// #2414: the orphan-chunk sweep against real SQLite (with D1's 100-bind
// ceiling) and an in-memory R2.
describe('cleanupOrphanedBlobChunks (#2414)', () => {
  let d1: SqliteD1
  let storage: R2Bucket

  const insertChunk = (id: string, refCount: number): string => {
    const key = `${USER_ID}/default/chunks/${id}`
    d1.raw
      .prepare(
        `INSERT INTO blob_chunks (id, hash, user_id, vault_id, r2_key, size_bytes, ref_count, created_at)
         VALUES (?, ?, ?, 'default', ?, 10, ?, 1)`
      )
      .run(id, `hash-${id}`, USER_ID, key, refCount)
    return key
  }

  const chunkIds = (): string[] =>
    (d1.raw.prepare('SELECT id FROM blob_chunks ORDER BY id').all() as Array<{ id: string }>).map(
      (row) => row.id
    )

  beforeEach(() => {
    d1 = createSqliteD1()
    storage = createMemoryR2()
    d1.raw
      .prepare(
        `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
         VALUES (?, 'orphans@example.com', 1, 'otp', 0, 0, 1, 1)`
      )
      .run(USER_ID)
  })

  afterEach(() => d1.close())

  it('reaps more orphaned chunks than one statement can bind, rows and objects', async () => {
    const keys: string[] = []
    for (let i = 0; i < 150; i++) {
      const key = insertChunk(`c${String(i).padStart(3, '0')}`, 0)
      keys.push(key)
      await storage.put(key, new ArrayBuffer(10))
    }
    const live = insertChunk('live', 1)
    await storage.put(live, new ArrayBuffer(10))

    const reaped = await cleanupOrphanedBlobChunks(d1.db, storage)

    expect(reaped).toBe(150)
    expect(chunkIds()).toEqual(['live'])
    for (const key of keys) expect(await storage.head(key)).toBeNull()
    expect(await storage.head(live)).not.toBeNull()
  })

  it('keeps the object of a chunk re-referenced between the select and the delete', async () => {
    const reused = insertChunk('reused', 0)
    const gone = insertChunk('gone', 0)
    await storage.put(reused, new ArrayBuffer(10))
    await storage.put(gone, new ArrayBuffer(10))

    // An upload of the same hash lands (ON CONFLICT ... ref_count + 1) after
    // the sweep read its candidates and before it deletes anything.
    const prepare = d1.db.prepare.bind(d1.db)
    const racing = {
      ...d1.db,
      prepare: (sql: string) => {
        if (/^\s*DELETE FROM blob_chunks/i.test(sql)) {
          d1.raw
            .prepare(`UPDATE blob_chunks SET ref_count = ref_count + 1 WHERE id = 'reused'`)
            .run()
        }
        return prepare(sql)
      }
    } as unknown as D1Database

    const reaped = await cleanupOrphanedBlobChunks(racing, storage)

    expect(reaped).toBe(1)
    expect(chunkIds()).toEqual(['reused'])
    expect(await storage.head(reused)).not.toBeNull()
    expect(await storage.head(gone)).toBeNull()
  })

  it('keeps the object of a chunk an upload re-created after the row delete', async () => {
    const key = insertChunk('retried', 0)
    await storage.put(key, new ArrayBuffer(10))

    // A client retrying the same bytes puts the object again and inserts a
    // fresh row after the sweep removed the old one.
    const prepare = d1.db.prepare.bind(d1.db)
    let recreated = false
    const racing = {
      ...d1.db,
      prepare: (sql: string) => {
        if (!recreated && /^\s*SELECT r2_key FROM blob_chunks/i.test(sql)) {
          recreated = true
          insertChunk('retried-2', 1)
          d1.raw.prepare('UPDATE blob_chunks SET r2_key = ? WHERE id = ?').run(key, 'retried-2')
        }
        return prepare(sql)
      }
    } as unknown as D1Database

    const reaped = await cleanupOrphanedBlobChunks(racing, storage)

    expect(reaped).toBe(1)
    expect(chunkIds()).toEqual(['retried-2'])
    expect(await storage.head(key)).not.toBeNull()
  })

  it('keeps a reaped row reaped when the object delete fails', async () => {
    const key = insertChunk('c1', 0)
    await storage.put(key, new ArrayBuffer(10))
    const failing = {
      ...storage,
      delete: async () => {
        throw new Error('r2 down')
      }
    } as unknown as R2Bucket

    const reaped = await cleanupOrphanedBlobChunks(d1.db, failing)

    expect(reaped).toBe(1)
    expect(chunkIds()).toEqual([])
  })
})
