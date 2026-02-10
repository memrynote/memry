import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cleanupExpiredLinkingSessions,
  cleanupExpiredOtpCodes,
  cleanupExpiredUploadSessions,
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
        { id: 's1', upload_id: 'up1', key: 'k1' },
        { id: 's2', upload_id: '', key: '' }
      ]
    })
    const selectBind = vi.fn().mockReturnValue({ all: selectAll })

    const deleteRun = vi.fn().mockResolvedValue({ meta: { changes: 2 } })
    const deleteBind = vi.fn().mockReturnValue({ run: deleteRun })

    const db = {
      prepare: vi.fn()
        .mockReturnValueOnce({ bind: selectBind })
        .mockReturnValueOnce({ bind: deleteBind })
    } as unknown as D1Database

    // #when
    const result = await cleanupExpiredUploadSessions(db, storage)

    // #then
    expect(result).toBe(2)
    expect(db.prepare).toHaveBeenCalledWith(
      'SELECT id, upload_id, key FROM upload_sessions WHERE expires_at < ?'
    )
    expect(db.prepare).toHaveBeenCalledWith(
      'DELETE FROM upload_sessions WHERE expires_at < ?'
    )
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
})
