import { describe, expect, it } from 'vitest'

import { hashTelemetryId } from './telemetry'

const VALID_INSTALL_ID = '550e8400-e29b-41d4-a716-446655440000'
const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440001'
const HMAC_KEY = 'test-telemetry-hmac-key'

describe('hashTelemetryId', () => {
  it('returns a stable hex HMAC for the same input', async () => {
    // #given a fixed key and id
    const a = await hashTelemetryId(HMAC_KEY, VALID_INSTALL_ID)
    const b = await hashTelemetryId(HMAC_KEY, VALID_INSTALL_ID)

    // #then both calls produce the same hex string
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]+$/)
    expect(a.length).toBe(64) // SHA-256 hex
  })

  it('returns different hashes for different ids', async () => {
    // #given two distinct ids
    const a = await hashTelemetryId(HMAC_KEY, VALID_INSTALL_ID)
    const b = await hashTelemetryId(HMAC_KEY, VALID_SESSION_ID)

    // #then their hashes differ
    expect(a).not.toBe(b)
  })

  it('never returns the raw id', async () => {
    // #given an id and a key
    const hash = await hashTelemetryId(HMAC_KEY, VALID_INSTALL_ID)

    // #then the hash does not contain the raw uuid
    expect(hash.includes(VALID_INSTALL_ID)).toBe(false)
  })

  it('throws when the key is empty', async () => {
    // #given an empty hmac key
    // #when hashing
    // #then it rejects
    await expect(hashTelemetryId('', VALID_INSTALL_ID)).rejects.toThrow()
  })
})
