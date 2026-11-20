import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { compactOneRange } from './pack-compaction'
import { packSha256 } from './pack-format'
import { rollupKind } from './pack-rollup'
import { PACK_SETTLE_SECONDS } from './pack-sizing'

/**
 * REVIEW-5277 P3: a pack object written before a listing batch that throws was
 * never recorded, so only the 1 h orphan sweep reached it, past the 900 s
 * purge deadline. A batch can also commit and lose its response, so the object
 * goes only when its own row is absent.
 */

const USER = 'user-listing-batch'
const VAULT = 'default'
const SCOPE = { userId: USER, vaultId: VAULT }

let harness: SqliteD1
let storage: R2Bucket

const settled = () => Math.floor(Date.now() / 1000) - PACK_SETTLE_SECONDS - 1

const writeRecord = async (cursor: number): Promise<void> => {
  const id = `task-${cursor}`
  const bytes = new TextEncoder().encode(JSON.stringify({ encryptedData: `${id}@${cursor}` }))
  const hash = Buffer.from(await packSha256(bytes)).toString('hex')
  const blobKey = `${USER}/vaults/${VAULT}/items-v3/task/${id}/${hash}`
  await storage.put(blobKey, bytes.slice().buffer)
  const at = settled()
  harness.raw
    .prepare(
      `INSERT INTO sync_items (id, user_id, vault_id, item_type, item_id, blob_key, size_bytes, content_hash, version, crypto_version, operation, server_cursor, signer_device_id, signature, clock, created_at, updated_at)
       VALUES (?, ?, ?, 'task', ?, ?, ?, ?, 1, 1, 'update', ?, 'device-1', 'sig', ?, ?, ?)`
    )
    .run(
      `row-${id}`,
      USER,
      VAULT,
      id,
      blobKey,
      bytes.byteLength,
      hash,
      cursor,
      `{"device-1":${cursor}}`,
      at,
      at
    )
}

const packKeys = async (): Promise<string[]> =>
  (await storage.list({ prefix: `${USER}/vaults/${VAULT}/packs/record/` })).objects.map(
    (o) => o.key
  )
const listedKeys = (): string[] =>
  harness.raw.prepare('SELECT pack_key FROM pack_index').pluck().all() as string[]
const unlisted = (): string[] =>
  harness.raw
    .prepare("SELECT pack_key FROM pack_replaced_objects WHERE replaced_by = 'unlisted'")
    .pluck()
    .all() as string[]

/** The next listing batch throws, after committing when `commits`. */
const failNextBatch = (commits: boolean): void => {
  const batch = harness.db.batch.bind(harness.db)
  vi.spyOn(harness.db, 'batch').mockImplementationOnce(async (statements) => {
    if (commits) await batch(statements)
    throw new Error('D1_ERROR: network')
  })
}

const buildRecordPacks = async (count: number): Promise<void> => {
  for (let i = 1; i <= count; i++) {
    await writeRecord(i)
    expect((await compactOneRange(harness.db, storage, SCOPE, 'record')).built).toBe(true)
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  harness = createSqliteD1()
  storage = createMemoryR2()
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, auth_method, created_at, updated_at) VALUES (?, 'batch@example.com', 'otp', 1, 1)`
    )
    .run(USER)
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES ('device-1', ?, 'desktop', 'desktop', '1.0.0', 'key', 1, 1)`
    )
    .run(USER)
})

afterEach(() => {
  harness.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('a listing batch that throws (REVIEW-5277 P3)', () => {
  it('build: an uncommitted batch records its object and deletes it', async () => {
    await writeRecord(1)
    failNextBatch(false)

    await expect(compactOneRange(harness.db, storage, SCOPE, 'record')).rejects.toThrow('D1_ERROR')

    expect(listedKeys()).toEqual([])
    expect(unlisted()).toHaveLength(1)
    expect(await packKeys()).toEqual([])
  })

  it('build: a committed batch keeps its listed object', async () => {
    await writeRecord(1)
    failNextBatch(true)

    await expect(compactOneRange(harness.db, storage, SCOPE, 'record')).rejects.toThrow('D1_ERROR')

    expect(listedKeys()).toHaveLength(1)
    expect(unlisted()).toEqual([])
    expect(await packKeys()).toEqual(listedKeys())
  })

  it('rollup: an uncommitted swap records the merged object and deletes it', async () => {
    await buildRecordPacks(8)
    const before = listedKeys().toSorted()
    failNextBatch(false)

    await expect(rollupKind(harness.db, storage, SCOPE, 'record')).rejects.toThrow('D1_ERROR')

    expect(listedKeys().toSorted()).toEqual(before)
    expect(unlisted()).toHaveLength(1)
    expect((await packKeys()).toSorted()).toEqual(before)
  })

  it('rollup: a committed swap keeps the merged object', async () => {
    await buildRecordPacks(8)
    failNextBatch(true)

    await expect(rollupKind(harness.db, storage, SCOPE, 'record')).rejects.toThrow('D1_ERROR')

    const [merged] = listedKeys()
    expect(listedKeys()).toHaveLength(1)
    expect(unlisted()).toEqual([])
    expect(await storage.get(merged)).not.toBeNull()
  })
})
