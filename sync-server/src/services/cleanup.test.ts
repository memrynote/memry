import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cleanupExpiredLinkingSessions,
  cleanupExpiredOtpCodes,
  cleanupExpiredTombstones,
  cleanupExpiredUploadSessions,
  cleanupOrphanedBlobChunks,
  cleanupStaleRateLimits
} from './cleanup'

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

  it('cleans up expired linking sessions', async () => {
    const { db, prepare, bind } = createDbWithChanges(5)

    await expect(cleanupExpiredLinkingSessions(db)).resolves.toBe(5)
    expect(prepare).toHaveBeenCalledWith('DELETE FROM linking_sessions WHERE expires_at < ?')
    expect(bind).toHaveBeenCalledWith(1_700_000_000)
  })

  it('cleans up expired upload sessions and aborts multipart uploads', async () => {
    // #given
    const abortFn = vi.fn().mockResolvedValue(undefined)
    const storage = {
      resumeMultipartUpload: vi.fn().mockReturnValue({ abort: abortFn })
    } as unknown as R2Bucket

    const selectAll = vi.fn().mockResolvedValue({
      results: [
        { id: 's1', r2_upload_id: 'up1', r2_key: 'k1' },
        { id: 's2', r2_upload_id: '', r2_key: '' }
      ]
    })
    const selectBind = vi.fn().mockReturnValue({ all: selectAll })

    const deleteRun = vi.fn().mockResolvedValue({ meta: { changes: 2 } })
    const deleteBind = vi.fn().mockReturnValue({ run: deleteRun })

    const db = {
      prepare: vi
        .fn()
        .mockReturnValueOnce({ bind: selectBind })
        .mockReturnValueOnce({ bind: deleteBind })
    } as unknown as D1Database

    // #when
    const result = await cleanupExpiredUploadSessions(db, storage)

    // #then
    expect(result).toBe(2)
    expect(db.prepare).toHaveBeenCalledWith(
      'SELECT id, r2_upload_id, r2_key FROM upload_sessions WHERE expires_at < ?'
    )
    expect(db.prepare).toHaveBeenCalledWith('DELETE FROM upload_sessions WHERE expires_at < ?')
    expect(storage.resumeMultipartUpload).toHaveBeenCalledWith('k1', 'up1')
    expect(abortFn).toHaveBeenCalledOnce()
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

  describe('cleanupExpiredTombstones', () => {
    const NINETY_DAYS = 90 * 24 * 60 * 60

    it('deletes R2 blobs and D1 rows for expired tombstones', async () => {
      // #given
      const storage = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket

      const selectAll = vi.fn().mockResolvedValue({
        results: [
          { id: 't1', blob_key: 'blob/t1' },
          { id: 't2', blob_key: 'blob/t2' }
        ]
      })
      const selectBind = vi.fn().mockReturnValue({ all: selectAll })

      const deleteRun = vi.fn().mockResolvedValue({ meta: { changes: 2 } })
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
      expect(result).toBe(2)
      expect(selectBind).toHaveBeenCalledWith(1_700_000_000 - NINETY_DAYS)
      expect(storage.delete).toHaveBeenCalledWith('blob/t1')
      expect(storage.delete).toHaveBeenCalledWith('blob/t2')
      expect(deleteBind).toHaveBeenCalledWith('t1', 't2')
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
          { id: 't1', blob_key: 'blob/t1' },
          { id: 't2', blob_key: 'blob/t2' }
        ]
      })
      const selectBind = vi.fn().mockReturnValue({ all: selectAll })

      const deleteRun = vi.fn().mockResolvedValue({ meta: { changes: 2 } })
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
      expect(result).toBe(2)
      expect(deleteBind).toHaveBeenCalledWith('t1', 't2')
    })

    it('uses correct 90-day cutoff in epoch seconds', async () => {
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
      expect(selectBind).toHaveBeenCalledWith(1_700_000_000 - 7_776_000)
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
