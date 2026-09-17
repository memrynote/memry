import { describe, it, expect, beforeEach } from 'vitest'
import { createMcpSession } from '../session'

describe('McpSession', () => {
  let session: ReturnType<typeof createMcpSession>

  beforeEach(() => {
    session = createMcpSession()
  })

  it('mints a 64-char hex bearer token on creation', () => {
    expect(session.token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rotates the token to a new value', () => {
    const previous = session.token
    const next = session.rotateToken()
    expect(next).not.toBe(previous)
    expect(session.token).toBe(next)
    expect(next).toMatch(/^[0-9a-f]{64}$/)
  })

  it('extracts the turn write capability from the X-Memry-Turn header', () => {
    const ctx = session.contextFromHeaders({
      authorization: `Bearer ${session.token}`,
      'x-memry-turn': 'turn-grant-42',
      'x-memry-window': 'win-7'
    })
    expect(ctx).toEqual({ writeGrant: 'turn-grant-42', windowId: 'win-7' })
  })

  it('returns null context when the header is absent (external client)', () => {
    const ctx = session.contextFromHeaders({ authorization: `Bearer ${session.token}` })
    expect(ctx).toEqual({ writeGrant: null, windowId: null })
  })

  it('never reads a write capability out of the old conversation header', () => {
    const ctx = session.contextFromHeaders({
      authorization: `Bearer ${session.token}`,
      'x-memry-conversation': 'conv-42'
    })
    expect(ctx.writeGrant).toBeNull()
  })

  it('verifies bearer token in constant time', () => {
    expect(session.verifyToken(session.token)).toBe(true)
    expect(session.verifyToken('deadbeef')).toBe(false)
    expect(session.verifyToken(undefined)).toBe(false)
  })
})
