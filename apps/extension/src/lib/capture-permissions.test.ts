import { describe, expect, it, vi } from 'vitest'
import { ensureHostPermission, LOOPBACK_ORIGIN } from './capture-permissions'

const origins = { origins: [LOOPBACK_ORIGIN] }

describe('ensureHostPermission', () => {
  it('returns true without prompting when the host is already granted', async () => {
    const request = vi.fn()
    const ok = await ensureHostPermission({
      contains: vi.fn().mockResolvedValue(true),
      request
    })
    expect(ok).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('requests the host when missing and returns the grant (approved)', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const ok = await ensureHostPermission({
      contains: vi.fn().mockResolvedValue(false),
      request
    })
    expect(ok).toBe(true)
    expect(request).toHaveBeenCalledWith(origins)
  })

  it('returns false when the user denies the request', async () => {
    const ok = await ensureHostPermission({
      contains: vi.fn().mockResolvedValue(false),
      request: vi.fn().mockResolvedValue(false)
    })
    expect(ok).toBe(false)
  })

  it('falls back to true when the permissions API throws', async () => {
    const ok = await ensureHostPermission({
      contains: vi.fn().mockRejectedValue(new Error('no api')),
      request: vi.fn()
    })
    expect(ok).toBe(true)
  })
})
