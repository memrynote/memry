import { describe, expect, it, vi } from 'vitest'

import { securityHeaders } from './security'

describe('securityHeaders middleware', () => {
  it('sets strict transport and anti-caching headers', async () => {
    const headers = new Map<string, string>()

    const context = {
      header: vi.fn((key: string, value: string) => {
        headers.set(key, value)
      })
    } as unknown as Parameters<typeof securityHeaders>[0]

    const next = vi.fn(async () => undefined)

    await securityHeaders(context, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains')
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers.get('X-Frame-Options')).toBe('DENY')
    expect(headers.get('Cache-Control')).toBe('no-store')
    expect(headers.get('Content-Security-Policy')).toBe("default-src 'none'; frame-ancestors 'none'")
  })
})
