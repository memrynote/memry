import { describe, expect, it } from 'vitest'

import { hashChannelToken, lookupChannel, verifyChannelToken } from './google-webhooks'

describe('hashChannelToken', () => {
  it('produces a stable hex digest of the expected length', async () => {
    // #given
    const secret = 'test-hmac-key-abcdef012345'

    // #when
    const a = await hashChannelToken(secret, 'token-1')
    const b = await hashChannelToken(secret, 'token-1')

    // #then
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces different digests for different tokens under the same secret', async () => {
    // #given
    const secret = 'test-hmac-key-abcdef012345'

    // #when
    const a = await hashChannelToken(secret, 'token-one')
    const b = await hashChannelToken(secret, 'token-two')

    // #then
    expect(a).not.toBe(b)
  })

  it('produces different digests for the same token under different secrets', async () => {
    // #given
    const token = 'token-shared'

    // #when
    const a = await hashChannelToken('secret-alpha', token)
    const b = await hashChannelToken('secret-beta', token)

    // #then
    expect(a).not.toBe(b)
  })
})

describe('verifyChannelToken', () => {
  const secret = 'test-hmac-key-abcdef012345'

  it('returns true when the presented token hashes to the expected digest', async () => {
    // #given
    const expected = await hashChannelToken(secret, 'correct-token')

    // #when
    const ok = await verifyChannelToken(secret, 'correct-token', expected)

    // #then
    expect(ok).toBe(true)
  })

  it('returns false on token mismatch', async () => {
    // #given
    const expected = await hashChannelToken(secret, 'correct-token')

    // #when
    const ok = await verifyChannelToken(secret, 'wrong-token', expected)

    // #then
    expect(ok).toBe(false)
  })

  it('returns false on digest length mismatch without throwing', async () => {
    // #given a truncated hash
    const truncated = 'deadbeef'

    // #when
    const ok = await verifyChannelToken(secret, 'any-token', truncated)

    // #then
    expect(ok).toBe(false)
  })
})

describe('lookupChannel', () => {
  function createDb(row: Record<string, unknown> | null) {
    return {
      prepare: () => ({
        bind: () => ({
          first: async () => row
        })
      })
    } as unknown as D1Database
  }

  it('returns the row when the channel exists', async () => {
    // #given
    const now = Math.floor(Date.now() / 1000)
    const db = createDb({
      channel_id: 'ch-1',
      user_id: 'user-1',
      device_id: 'device-1',
      source_id: 'google-calendar:abc',
      resource_id: 'resource-1',
      token_hash: 'abc',
      expires_at: now + 600
    })

    // #when
    const row = await lookupChannel(db, 'ch-1')

    // #then
    expect(row).not.toBeNull()
    expect(row?.user_id).toBe('user-1')
    expect(row?.source_id).toBe('google-calendar:abc')
    expect(row?.resource_id).toBe('resource-1')
  })

  it('returns null when the channel does not exist', async () => {
    // #given
    const db = createDb(null)

    // #when
    const row = await lookupChannel(db, 'ch-missing')

    // #then
    expect(row).toBeNull()
  })
})
