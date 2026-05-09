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

  it('extracts conversation id from X-Memry-Conversation header', () => {
    const ctx = session.contextFromHeaders({
      authorization: `Bearer ${session.token}`,
      'x-memry-conversation': 'conv-42',
      'x-memry-window': 'win-7'
    })
    expect(ctx).toEqual({ conversationId: 'conv-42', windowId: 'win-7' })
  })

  it('returns null context when the header is absent (external client)', () => {
    const ctx = session.contextFromHeaders({ authorization: `Bearer ${session.token}` })
    expect(ctx).toEqual({ conversationId: null, windowId: null })
  })

  it('verifies bearer token in constant time', () => {
    expect(session.verifyToken(session.token)).toBe(true)
    expect(session.verifyToken('deadbeef')).toBe(false)
    expect(session.verifyToken(undefined)).toBe(false)
  })
})
