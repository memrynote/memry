import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cleanupExpiredLinkingSessions,
  cleanupExpiredOtpCodes,
  cleanupExpiredUploadSessions
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

  it('cleans up expired upload sessions', async () => {
    const { db, prepare, bind } = createDbWithChanges(2)

    await expect(cleanupExpiredUploadSessions(db)).resolves.toBe(2)
    expect(prepare).toHaveBeenCalledWith('DELETE FROM upload_sessions WHERE expires_at < ?')
    expect(bind).toHaveBeenCalledWith(1_700_000_000)
  })
})
