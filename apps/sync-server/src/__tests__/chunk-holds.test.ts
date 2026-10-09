import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { holdChunks, releaseHolds } from '../services/chunk-holds'
import { cleanupOrphanedBlobChunks } from '../services/cleanup'
import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'

const USER_ID = 'user-1'
const VAULT_ID = 'vault-1'
const HOLDER_A = 'a'.repeat(64)
const HOLDER_B = 'b'.repeat(64)

// #3022: holds keep a reused image's chunks alive after the upload's own
// reference is gone, are idempotent per holder, and refund the bytes once.
describe('attachment chunk holds (#3022)', () => {
  let d1: SqliteD1
  let storage: R2Bucket

  const insertChunk = (hash: string, refCount: number): string => {
    const key = `${USER_ID}/vaults/${VAULT_ID}/chunks/${hash}`
    d1.raw
      .prepare(
        `INSERT INTO blob_chunks (id, hash, user_id, vault_id, r2_key, size_bytes, ref_count, created_at)
         VALUES (?, ?, ?, ?, ?, 100, ?, 1)`
      )
      .run(`id-${hash}`, hash, USER_ID, VAULT_ID, key, refCount)
    return key
  }

  const storageUsed = (): number =>
    (
      d1.raw.prepare('SELECT storage_used FROM users WHERE id = ?').get(USER_ID) as {
        storage_used: number
      }
    ).storage_used

  const chunkHashes = (): string[] =>
    (
      d1.raw.prepare('SELECT hash FROM blob_chunks ORDER BY hash').all() as Array<{ hash: string }>
    ).map((row) => row.hash)

  const setRefCount = (hash: string, refCount: number): void => {
    d1.raw.prepare('UPDATE blob_chunks SET ref_count = ? WHERE hash = ?').run(refCount, hash)
  }

  beforeEach(() => {
    d1 = createSqliteD1()
    storage = createMemoryR2()
    d1.raw
      .prepare(
        `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
         VALUES (?, 'holds@example.com', 1, 'otp', 1000, 0, 1, 1)`
      )
      .run(USER_ID)
  })

  afterEach(() => d1.close())

  it('keeps a held chunk through the orphan sweep after its upload ref is gone', async () => {
    const key = insertChunk('h1', 1)
    await storage.put(key, new ArrayBuffer(100))

    expect(
      await holdChunks(d1.db, USER_ID, VAULT_ID, [{ holderId: HOLDER_A, chunkHashes: ['h1'] }])
    ).toEqual([])
    setRefCount('h1', 0)

    expect(await cleanupOrphanedBlobChunks(d1.db, storage)).toBe(0)
    expect(chunkHashes()).toEqual(['h1'])
    expect(await storage.head(key)).not.toBeNull()

    await releaseHolds(d1.db, USER_ID, VAULT_ID, [HOLDER_A])
    expect(await cleanupOrphanedBlobChunks(d1.db, storage)).toBe(1)
    expect(chunkHashes()).toEqual([])
  })

  it('reports a holder whose chunk is gone or dead as missing and holds none of it', async () => {
    insertChunk('live', 1)
    insertChunk('dead', 0)

    const missing = await holdChunks(d1.db, USER_ID, VAULT_ID, [
      { holderId: HOLDER_A, chunkHashes: ['live', 'reaped'] },
      { holderId: HOLDER_B, chunkHashes: ['dead'] }
    ])

    expect(missing).toEqual([HOLDER_A, HOLDER_B])
    const holds = d1.raw.prepare('SELECT holder_id, chunk_hash FROM attachment_chunk_holds').all()
    expect(holds).toEqual([{ holder_id: HOLDER_A, chunk_hash: 'live' }])
  })

  it('treats a repeated hold as one hold', async () => {
    insertChunk('h1', 1)
    const hold = () =>
      holdChunks(d1.db, USER_ID, VAULT_ID, [{ holderId: HOLDER_A, chunkHashes: ['h1', 'h1'] }])

    expect(await hold()).toEqual([])
    expect(await hold()).toEqual([])
    setRefCount('h1', 0)

    // One release drops it: a second count would have kept the chunk alive.
    expect(await releaseHolds(d1.db, USER_ID, VAULT_ID, [HOLDER_A])).toBe(1)
    expect(await cleanupOrphanedBlobChunks(d1.db, storage)).toBe(1)
  })

  it('refunds a chunk once when its last hold is released twice', async () => {
    insertChunk('h1', 1)
    await holdChunks(d1.db, USER_ID, VAULT_ID, [
      { holderId: HOLDER_A, chunkHashes: ['h1'] },
      { holderId: HOLDER_B, chunkHashes: ['h1'] }
    ])
    setRefCount('h1', 0)

    expect(await releaseHolds(d1.db, USER_ID, VAULT_ID, [HOLDER_A])).toBe(1)
    expect(storageUsed()).toBe(1000)
    expect(await releaseHolds(d1.db, USER_ID, VAULT_ID, [HOLDER_B])).toBe(1)
    expect(storageUsed()).toBe(900)
    expect(await releaseHolds(d1.db, USER_ID, VAULT_ID, [HOLDER_B, HOLDER_A])).toBe(0)
    expect(storageUsed()).toBe(900)
  })

  it('does not refund a released chunk that an upload still references', async () => {
    insertChunk('h1', 1)
    await holdChunks(d1.db, USER_ID, VAULT_ID, [{ holderId: HOLDER_A, chunkHashes: ['h1'] }])

    await releaseHolds(d1.db, USER_ID, VAULT_ID, [HOLDER_A])

    expect(storageUsed()).toBe(1000)
    expect(await cleanupOrphanedBlobChunks(d1.db, storage)).toBe(0)
  })
})
