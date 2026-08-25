import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { handlePackQueueMessage } from './pack-consumer'

/**
 * Queue-handler wiring without real Queues (#1839): a valid message invokes
 * the compaction core, malformed messages are ACKed (never retried), and core
 * failures propagate so the platform retries the delivery.
 */

const USER = 'user-queue'
let harness: SqliteD1
let storage: R2Bucket

beforeEach(() => {
  harness = createSqliteD1()
  storage = createMemoryR2()
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, auth_method, created_at, updated_at)
       VALUES (?, 'q@example.com', 'otp', 1, 1)`
    )
    .run(USER)
})

describe('handlePackQueueMessage', () => {
  it('compacts the vault for a well-formed message', async () => {
    const blobKey = `${USER}/vaults/default/items-v3/task/i-1/h1`
    storage.put(blobKey, new TextEncoder().encode('{"encryptedData":"x"}').buffer as ArrayBuffer)
    harness.raw
      .prepare(
        `INSERT INTO sync_items (id, user_id, vault_id, item_type, item_id, blob_key, size_bytes, content_hash, version, crypto_version, operation, server_cursor, signer_device_id, signature, clock, created_at, updated_at, deleted_at)
         VALUES ('r1', ?, 'default', 'task', 'i-1', ?, 24, 'h1', 1, 1, 'update', 5, NULL, 'sig', NULL, 1, 1, NULL)`
      )
      .run(USER, blobKey)

    await handlePackQueueMessage({ DB: harness.db, STORAGE: storage }, { userId: USER, vaultId: 'default' })

    expect(
      (harness.raw.prepare('SELECT COUNT(*) c FROM pack_index').get() as { c: number }).c
    ).toBe(1)
    expect(
      (harness.raw.prepare('SELECT COUNT(*) c FROM pack_watermarks').get() as { c: number }).c
    ).toBeGreaterThanOrEqual(1)
  })

  it('ACKs malformed messages instead of burning retries on poison input', async () => {
    for (const body of [null, {}, { userId: '' }, { userId: 'u' }, 42, 'nope']) {
      await expect(
        handlePackQueueMessage({ DB: harness.db, STORAGE: storage }, body)
      ).resolves.toBeUndefined()
    }
    expect(
      (harness.raw.prepare('SELECT COUNT(*) c FROM pack_index').get() as { c: number }).c
    ).toBe(0)
  })

  it('propagates core failures so delivery is retried', async () => {
    // Storage that throws simulates an R2 outage mid-build.
    const failingStorage = {
      get: vi.fn().mockRejectedValue(new Error('r2 unavailable'))
    } as unknown as R2Bucket
    harness.raw
      .prepare(
        `INSERT INTO sync_items (id, user_id, vault_id, item_type, item_id, blob_key, size_bytes, content_hash, version, crypto_version, operation, server_cursor, signer_device_id, signature, clock, created_at, updated_at, deleted_at)
         VALUES ('r1', ?, 'default', 'task', 'i-1', 'k', 10, 'h1', 1, 1, 'update', 1, NULL, 'sig', NULL, 1, 1, NULL)`
      )
      .run(USER)

    await expect(
      handlePackQueueMessage({ DB: harness.db, STORAGE: failingStorage }, { userId: USER, vaultId: 'default' })
    ).rejects.toThrow('r2 unavailable')
  })
})
