import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cleanupConsumedSetupTokens,
  cleanupExpiredGoogleCalendarChannels,
  cleanupExpiredLinkingSessions,
  cleanupExpiredOtpCodes,
  cleanupExpiredTombstones,
  cleanupExpiredUploadSessions,
  cleanupOrphanedBlobChunks,
  cleanupStaleIdentifySessions,
  cleanupStaleRateLimits
} from './cleanup'
import { IDENTIFY_SESSION_TTL_SECONDS } from './telemetry-identify'

function createDbWithChanges(changes: number) {
  const run = vi.fn(async () => ({ meta: { changes } }))
  const bind = vi.fn(() => ({ run }))
  const prepare = vi.fn(() => ({ bind }))

  return {
    db: { prepare } as unknown as D1Database,
    prepare,
    bind,
    run
  }
}

describe('cleanup services', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  })

  it('cleans up expired OTP codes', async () => {
    const { db, prepare, bind } = createDbWithChanges(3)

    await expect(cleanupExpiredOtpCodes(db)).resolves.toBe(3)
    expect(prepare).toHaveBeenCalledWith('DELETE FROM otp_codes WHERE expires_at < ?')
    expect(bind).toHaveBeenCalledWith(1_700_000_000)
  })

  it('returns 0 when D1 omits changes metadata for simple cleanup queries', async () => {
    const run = vi.fn(async () => ({ meta: {} }))
    const bind = vi.fn(() => ({ run }))
    const prepare = vi.fn(() => ({ bind }))
    const db = { prepare } as unknown as D1Database

    await expect(cleanupExpiredOtpCodes(db)).resolves.toBe(0)
  })

  it('cleans up expired linking sessions', async () => {
    const { db, prepare, bind } = createDbWithChanges(5)

    await expect(cleanupExpiredLinkingSessions(db)).resolves.toBe(5)
    expect(prepare).toHaveBeenCalledWith('DELETE FROM linking_sessions WHERE expires_at < ?')
    expect(bind).toHaveBeenCalledWith(1_700_000_000)
  })

  it('cleans up expired upload sessions, chunks, and reserved storage', async () => {
    // #given
    const abortFn = vi.fn().mockResolvedValue(undefined)
    const storage = {
      delete: vi.fn().mockResolvedValue(undefined),
      resumeMultipartUpload: vi.fn().mockReturnValue({ abort: abortFn })
    } as unknown as R2Bucket

    const selectAll = vi.fn().mockResolvedValue({
      results: [
        {
          id: 's1',
          user_id: 'user-1',
          vault_id: 'vault-1',
          total_size: 10,
          chunk_count: 1,
          encrypted_size: null,
          uploaded_chunks: JSON.stringify([{ i: 0, h: 'hash-0', b: 50 }]),
          r2_upload_id: 'up1',
          r2_key: 'k1'
        },
        {
          id: 's2',
          user_id: 'user-2',
          vault_id: 'vault-2',
          total_size: 20,
          chunk_count: 2,
          encrypted_size: 100,
          uploaded_chunks: '[]',
          r2_upload_id: '',
          r2_key: ''
        }
      ]
    })
    const selectBind = vi.fn().mockReturnValue({ all: selectAll })

    const chunkFirst = vi.fn().mockResolvedValue({
      id: 'chunk-1',
      ref_count: 1,
      r2_key: 'user-1/vaults/vault-1/chunks/hash-0'
    })
    const chunkBind = vi.fn().mockReturnValue({ first: chunkFirst })
    const deleteChunkRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const deleteChunkBind = vi.fn().mockReturnValue({ run: deleteChunkRun })

    const deleteRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const deleteBind = vi.fn().mockReturnValue({ run: deleteRun })
    const releaseRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const releaseBind = vi.fn().mockReturnValue({ run: releaseRun })

    const db = {
      prepare: vi
        .fn()
        .mockReturnValueOnce({ bind: selectBind })
        .mockReturnValueOnce({ bind: chunkBind })
        .mockReturnValueOnce({ bind: deleteChunkBind })
        .mockReturnValueOnce({ bind: deleteBind })
        .mockReturnValueOnce({ bind: releaseBind })
        .mockReturnValueOnce({ bind: deleteBind })
        .mockReturnValueOnce({ bind: releaseBind })
    } as unknown as D1Database

    // #when
    const result = await cleanupExpiredUploadSessions(db, storage)

    // #then
    expect(result).toBe(2)
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining(
        'SELECT id, user_id, vault_id, total_size, chunk_count, encrypted_size'
      )
    )
    expect(db.prepare).toHaveBeenCalledWith(
      'SELECT id, ref_count, r2_key FROM blob_chunks WHERE user_id = ? AND vault_id = ? AND hash = ?'
    )
    expect(storage.delete).toHaveBeenCalledWith('user-1/vaults/vault-1/chunks/hash-0')
    expect(db.prepare).toHaveBeenCalledWith(
      'DELETE FROM upload_sessions WHERE id = ? AND user_id = ? AND vault_id = ?'
    )
    // s1 is a legacy row (encrypted_size IS NULL): the OLD server reserved the
    // plaintext total_size, so refunding a derived ciphertext total would hand
    // back bytes that were never reserved.
    expect(releaseBind).toHaveBeenCalledWith(-10, expect.any(Number), 'user-1')
    // s2 was written by the new server: refund exactly what it reserved.
    expect(releaseBind).toHaveBeenCalledWith(-100, expect.any(Number), 'user-2')
    expect(storage.resumeMultipartUpload).toHaveBeenCalledWith('k1', 'up1')
    expect(abortFn).toHaveBeenCalledOnce()
  })

  it('continues deleting expired upload sessions when multipart abort fails', async () => {
    // #given
    const abortFn = vi.fn().mockRejectedValue(new Error('already gone'))
    const storage = {
      delete: vi.fn(),
      resumeMultipartUpload: vi.fn().mockReturnValue({ abort: abortFn })
    } as unknown as R2Bucket

    // A legacy session: written by the old server, which reserved the PLAINTEXT
    // total_size, so encrypted_size is NULL and must not be re-derived on refund.
    const selectAll = vi.fn().mockResolvedValue({
      results: [
        {
          id: 's1',
          user_id: 'user-1',
          vault_id: 'vault-1',
          total_size: 5_000,
          chunk_count: 3,
          encrypted_size: null,
          uploaded_chunks: '[]',
          r2_upload_id: 'up1',
          r2_key: 'k1'
        }
      ]
    })
    const selectBind = vi.fn().mockReturnValue({ all: selectAll })

    const deleteRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const deleteBind = vi.fn().mockReturnValue({ run: deleteRun })
    const releaseRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const releaseBind = vi.fn().mockReturnValue({ run: releaseRun })

    const db = {
      prepare: vi
        .fn()
        .mockReturnValueOnce({ bind: selectBind })
        .mockReturnValueOnce({ bind: deleteBind })
        .mockReturnValueOnce({ bind: releaseBind })
    } as unknown as D1Database

    // #when
    const result = await cleanupExpiredUploadSessions(db, storage)

    // #then
    expect(result).toBe(1)
    expect(abortFn).toHaveBeenCalledOnce()
    expect(deleteRun).toHaveBeenCalledOnce()
    // refunds what was reserved (plaintext), not total_size + 40 * chunk_count
    expect(releaseBind).toHaveBeenCalledWith(-5_000, expect.any(Number), 'user-1')
  })

  it('cleans up expired Google Calendar push channels', async () => {
    // #given
    const { db, prepare, bind } = createDbWithChanges(4)

    // #when
    const result = await cleanupExpiredGoogleCalendarChannels(db)

    // #then
    expect(result).toBe(4)
    expect(prepare).toHaveBeenCalledWith(
      'DELETE FROM google_calendar_channels WHERE expires_at < ?'
    )
    expect(bind).toHaveBeenCalledWith(1_700_000_000)
  })

  it('cleans up consumed setup tokens', async () => {
    // #given
    const { db, prepare, bind } = createDbWithChanges(6)

    // #when
    const result = await cleanupConsumedSetupTokens(db)

    // #then
    expect(result).toBe(6)
    expect(prepare).toHaveBeenCalledWith('DELETE FROM consumed_setup_tokens WHERE expires_at < ?')
    expect(bind).toHaveBeenCalledWith(1_700_000_000)
  })

  it('cleans up stale rate limits older than 1 hour', async () => {
    // #given
    const { db, prepare, bind } = createDbWithChanges(7)

    // #when
    const result = await cleanupStaleRateLimits(db)

    // #then
    expect(result).toBe(7)
    expect(prepare).toHaveBeenCalledWith('DELETE FROM rate_limits WHERE window_start < ?')
    expect(bind).toHaveBeenCalledWith(1_700_000_000 - 3600)
  })

  it('cleans up $identify session claims older than the TTL', async () => {
    // #given
    const { db, prepare, bind } = createDbWithChanges(8)

    // #when
    const result = await cleanupStaleIdentifySessions(db)

    // #then
    expect(result).toBe(8)
    expect(prepare).toHaveBeenCalledWith(
      'DELETE FROM telemetry_identify_sessions WHERE created_at < ?'
    )
    expect(bind).toHaveBeenCalledWith(1_700_000_000 - IDENTIFY_SESSION_TTL_SECONDS)
  })

  describe('cleanupExpiredTombstones', () => {
    it('deletes R2 blobs and D1 rows for expired tombstones', async () => {
      // #given
      const storage = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket

      const selectAll = vi.fn().mockResolvedValue({
        results: [
          { id: 't1', blob_key: 'blob/t1', user_id: 'user-1', size_bytes: 10 },
          { id: 't2', blob_key: 'blob/t2', user_id: 'user-1', size_bytes: 5 }
        ]
      })
      const selectBind = vi.fn().mockReturnValue({ all: selectAll })

      const deleteRun = vi.fn().mockResolvedValue({ meta: { changes: 2 } })
      const deleteBind = vi.fn().mockReturnValue({ run: deleteRun })
      const updateRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
      const updateBind = vi.fn().mockReturnValue({ run: updateRun })

      const db = {
        prepare: vi
          .fn()
          .mockReturnValueOnce({ bind: selectBind })
          .mockReturnValueOnce({ bind: deleteBind })
          .mockReturnValueOnce({ bind: updateBind })
      } as unknown as D1Database

      // #when
      const result = await cleanupExpiredTombstones(db, storage)

      // #then
      expect(result).toBe(2)
      expect(selectBind).toHaveBeenCalledWith(1_700_000_000)
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('version_history_days'))
      expect(storage.delete).toHaveBeenCalledWith('blob/t1')
      expect(storage.delete).toHaveBeenCalledWith('blob/t2')
      expect(deleteBind).toHaveBeenCalledWith('t1', 't2')
      expect(db.prepare).toHaveBeenCalledWith(
        'UPDATE users SET storage_used = MAX(0, storage_used - ?), updated_at = ? WHERE id = ?'
      )
      expect(updateBind).toHaveBeenCalledWith(15, expect.any(Number), 'user-1')
    })

    it('returns 0 when D1 delete omits tombstone changes metadata', async () => {
      // #given
      const storage = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket

      const selectAll = vi.fn().mockResolvedValue({
        results: [{ id: 't1', blob_key: 'blob/t1', user_id: 'user-1', size_bytes: 10 }]
      })
      const selectBind = vi.fn().mockReturnValue({ all: selectAll })

      const deleteRun = vi.fn().mockResolvedValue({ meta: {} })
      const deleteBind = vi.fn().mockReturnValue({ run: deleteRun })

      const db = {
        prepare: vi
          .fn()
          .mockReturnValueOnce({ bind: selectBind })
          .mockReturnValueOnce({ bind: deleteBind })
      } as unknown as D1Database

      // #when
      const result = await cleanupExpiredTombstones(db, storage)

      // #then
      expect(result).toBe(0)
      expect(storage.delete).toHaveBeenCalledWith('blob/t1')
    })

    it('returns 0 when no expired tombstones exist', async () => {
      // #given
      const storage = { delete: vi.fn() } as unknown as R2Bucket

      const selectAll = vi.fn().mockResolvedValue({ results: [] })
      const selectBind = vi.fn().mockReturnValue({ all: selectAll })

      const db = {
        prepare: vi.fn().mockReturnValueOnce({ bind: selectBind })
      } as unknown as D1Database

      // #when
      const result = await cleanupExpiredTombstones(db, storage)

      // #then
      expect(result).toBe(0)
      expect(storage.delete).not.toHaveBeenCalled()
    })

    it('still hard-deletes D1 rows when R2 delete fails', async () => {
      // #given
      const storage = {
        delete: vi
          .fn()
          .mockRejectedValueOnce(new Error('R2 unavailable'))
          .mockResolvedValue(undefined)
      } as unknown as R2Bucket

      const selectAll = vi.fn().mockResolvedValue({
        results: [
          { id: 't1', blob_key: 'blob/t1', user_id: 'user-1', size_bytes: 10 },
          { id: 't2', blob_key: 'blob/t2', user_id: 'user-2', size_bytes: 15 }
        ]
      })
      const selectBind = vi.fn().mockReturnValue({ all: selectAll })

      const deleteRun = vi.fn().mockResolvedValue({ meta: { changes: 2 } })
      const deleteBind = vi.fn().mockReturnValue({ run: deleteRun })
      const updateRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
      const updateBind = vi.fn().mockReturnValue({ run: updateRun })

      const db = {
        prepare: vi
          .fn()
          .mockReturnValueOnce({ bind: selectBind })
          .mockReturnValueOnce({ bind: deleteBind })
          .mockReturnValue({ bind: updateBind })
      } as unknown as D1Database

      // #when
      const result = await cleanupExpiredTombstones(db, storage)

      // #then
      expect(result).toBe(2)
      expect(deleteBind).toHaveBeenCalledWith('t1', 't2')
      expect(updateBind).toHaveBeenCalledWith(10, expect.any(Number), 'user-1')
      expect(updateBind).toHaveBeenCalledWith(15, expect.any(Number), 'user-2')
    })

    it('uses the user plan version-history window for tombstone expiry', async () => {
      // #given
      const storage = { delete: vi.fn() } as unknown as R2Bucket

      const selectAll = vi.fn().mockResolvedValue({ results: [] })
      const selectBind = vi.fn().mockReturnValue({ all: selectAll })

      const db = {
        prepare: vi.fn().mockReturnValueOnce({ bind: selectBind })
      } as unknown as D1Database

      // #when
      await cleanupExpiredTombstones(db, storage)

      // #then
      expect(selectBind).toHaveBeenCalledWith(1_700_000_000)
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('sync_entitlements'))
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('version_history_days'))
    })
  })

  describe('cleanupOrphanedBlobChunks', () => {
    it('deletes R2 blobs and D1 rows for orphaned chunks', async () => {
      // #given
      const storage = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket

      const selectAll = vi.fn().mockResolvedValue({
        results: [
          { id: 'c1', r2_key: 'chunks/c1' },
          { id: 'c2', r2_key: 'chunks/c2' }
        ]
      })

      const deleteRun = vi.fn().mockResolvedValue({ meta: { changes: 2 } })
      const deleteBind = vi.fn().mockReturnValue({ run: deleteRun })

      const db = {
        prepare: vi
          .fn()
          .mockReturnValueOnce({ all: selectAll })
          .mockReturnValueOnce({ bind: deleteBind })
      } as unknown as D1Database

      // #when
      const result = await cleanupOrphanedBlobChunks(db, storage)

      // #then
      expect(result).toBe(2)
      expect(storage.delete).toHaveBeenCalledWith('chunks/c1')
      expect(storage.delete).toHaveBeenCalledWith('chunks/c2')
      expect(deleteBind).toHaveBeenCalledWith('c1', 'c2')
    })

    it('still deletes orphaned chunk rows when R2 delete fails and D1 changes are omitted', async () => {
      // #given
      const storage = {
        delete: vi.fn().mockRejectedValue(new Error('missing'))
      } as unknown as R2Bucket

      const selectAll = vi.fn().mockResolvedValue({
        results: [{ id: 'c1', r2_key: 'chunks/c1' }]
      })

      const deleteRun = vi.fn().mockResolvedValue({ meta: {} })
      const deleteBind = vi.fn().mockReturnValue({ run: deleteRun })

      const db = {
        prepare: vi
          .fn()
          .mockReturnValueOnce({ all: selectAll })
          .mockReturnValueOnce({ bind: deleteBind })
      } as unknown as D1Database

      // #when
      const result = await cleanupOrphanedBlobChunks(db, storage)

      // #then
      expect(result).toBe(0)
      expect(deleteBind).toHaveBeenCalledWith('c1')
    })

    it('returns 0 when no orphaned chunks exist', async () => {
      // #given
      const storage = { delete: vi.fn() } as unknown as R2Bucket

      const selectAll = vi.fn().mockResolvedValue({ results: [] })

      const db = {
        prepare: vi.fn().mockReturnValueOnce({ all: selectAll })
      } as unknown as D1Database

      // #when
      const result = await cleanupOrphanedBlobChunks(db, storage)

      // #then
      expect(result).toBe(0)
      expect(storage.delete).not.toHaveBeenCalled()
    })
  })
})
