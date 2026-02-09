import { describe, it, expect, vi } from 'vitest'

import { securityHeaders } from './security'

// ============================================================================
// Hono context mock
// ============================================================================

const createMockContext = () => {
  const headers: Record<string, string> = {}
  return {
    c: {
      header: vi.fn((name: string, value: string) => {
        headers[name] = value
      }),
      _headers: headers
    },
    next: vi.fn().mockResolvedValue(undefined)
  }
}

// ============================================================================
// Tests: securityHeaders
// ============================================================================

describe('securityHeaders', () => {
  it('should call next before setting headers', async () => {
    // #given
    const { c, next } = createMockContext()
    const callOrder: string[] = []
    next.mockImplementation(async () => {
      callOrder.push('next')
    })
    c.header = vi.fn((..._args: unknown[]) => {
      callOrder.push('header')
    }) as ReturnType<typeof vi.fn>

    // #when
    await securityHeaders(c as never, next)

    // #then
    expect(callOrder[0]).toBe('next')
    expect(callOrder.filter((c) => c === 'header').length).toBeGreaterThanOrEqual(4)
  })

  it('should set Strict-Transport-Security header', async () => {
    // #given
    const { c, next } = createMockContext()

    // #when
    await securityHeaders(c as never, next)

    // #then
    expect(c._headers['Strict-Transport-Security']).toBe(
      'max-age=31536000; includeSubDomains'
    )
  })

  it('should set X-Content-Type-Options to nosniff', async () => {
    // #given
    const { c, next } = createMockContext()

    // #when
    await securityHeaders(c as never, next)

    // #then
    expect(c._headers['X-Content-Type-Options']).toBe('nosniff')
  })

  it('should set X-Frame-Options to DENY', async () => {
    // #given
    const { c, next } = createMockContext()

    // #when
    await securityHeaders(c as never, next)

    // #then
    expect(c._headers['X-Frame-Options']).toBe('DENY')
  })

  it('should set Cache-Control to no-store', async () => {
    // #given
    const { c, next } = createMockContext()

    // #when
    await securityHeaders(c as never, next)

    // #then
    expect(c._headers['Cache-Control']).toBe('no-store')
  })

  it('should set Content-Security-Policy with restrictive defaults', async () => {
    // #given
    const { c, next } = createMockContext()

    // #when
    await securityHeaders(c as never, next)

    // #then
    expect(c._headers['Content-Security-Policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'"
    )
  })
})
