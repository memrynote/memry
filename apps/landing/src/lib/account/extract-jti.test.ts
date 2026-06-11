import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractJti } from './extract-jti.ts'

describe('extractJti', () => {
  it('reads the jti claim from a JWT payload', () => {
    const payload = Buffer.from(JSON.stringify({ jti: 'abc-123', sub: 'u1' })).toString('base64url')
    const jwt = `header.${payload}.sig`
    assert.equal(extractJti(jwt), 'abc-123')
  })

  it('throws when the token has no jti', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url')
    assert.throws(() => extractJti(`h.${payload}.s`))
  })
})
