import { describe, expect, it, vi } from 'vitest'
import {
  ensureCapturePermissions,
  hasOriginPermission,
  LOOPBACK_ORIGIN
} from './capture-permissions'

const origins = { origins: [LOOPBACK_ORIGIN] }

describe('ensureCapturePermissions — loopback only', () => {
  it('returns true without prompting when the host is already granted', async () => {
    const request = vi.fn()
    const ok = await ensureCapturePermissions(null, {
      contains: vi.fn().mockResolvedValue(true),
      request
    })
    expect(ok).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('requests the host when missing and returns the grant (approved)', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const ok = await ensureCapturePermissions(null, {
      contains: vi.fn().mockResolvedValue(false),
      request
    })
    expect(ok).toBe(true)
    expect(request).toHaveBeenCalledWith(origins)
  })

  it('returns false when the user denies the request', async () => {
    const ok = await ensureCapturePermissions(null, {
      contains: vi.fn().mockResolvedValue(false),
      request: vi.fn().mockResolvedValue(false)
    })
    expect(ok).toBe(false)
  })

  it('falls back to true when the permissions API throws', async () => {
    const ok = await ensureCapturePermissions(null, {
      contains: vi.fn().mockRejectedValue(new Error('no api')),
      request: vi.fn()
    })
    expect(ok).toBe(true)
  })
})

describe('ensureCapturePermissions', () => {
  it('requests loopback and the page origin in ONE call', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const ok = await ensureCapturePermissions('https://example.com/paper.pdf', {
      contains: vi.fn().mockResolvedValue(false),
      request
    })
    expect(ok).toBe(true)
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith({
      origins: [LOOPBACK_ORIGIN, 'https://example.com/*']
    })
  })

  it('asks for loopback only when there is no fetchable page url', async () => {
    const request = vi.fn().mockResolvedValue(true)
    await ensureCapturePermissions(null, {
      contains: vi.fn().mockResolvedValue(false),
      request
    })
    expect(request).toHaveBeenCalledWith({ origins: [LOOPBACK_ORIGIN] })
  })

  it('asks for loopback only when the page url is not http(s)', async () => {
    const request = vi.fn().mockResolvedValue(true)
    await ensureCapturePermissions('chrome://settings', {
      contains: vi.fn().mockResolvedValue(false),
      request
    })
    expect(request).toHaveBeenCalledWith({ origins: [LOOPBACK_ORIGIN] })
  })

  it('does not prompt when everything is already granted', async () => {
    const request = vi.fn()
    const ok = await ensureCapturePermissions('https://example.com/a.pdf', {
      contains: vi.fn().mockResolvedValue(true),
      request
    })
    expect(ok).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('returns false when the user denies site access', async () => {
    const ok = await ensureCapturePermissions('https://example.com/a.pdf', {
      contains: vi.fn().mockResolvedValue(false),
      request: vi.fn().mockResolvedValue(false)
    })
    expect(ok).toBe(false)
  })
})

describe('hasOriginPermission', () => {
  it('reports a granted origin without ever prompting', async () => {
    const request = vi.fn()
    const ok = await hasOriginPermission('https://example.com/a.pdf', {
      contains: vi.fn().mockResolvedValue(true),
      request
    })
    expect(ok).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('reports false for a non-http(s) url', async () => {
    const ok = await hasOriginPermission('chrome://settings', {
      contains: vi.fn().mockResolvedValue(true),
      request: vi.fn()
    })
    expect(ok).toBe(false)
  })

  it('reports false when the permissions API throws', async () => {
    const ok = await hasOriginPermission('https://example.com/a.pdf', {
      contains: vi.fn().mockRejectedValue(new Error('no api')),
      request: vi.fn()
    })
    expect(ok).toBe(false)
  })
})
