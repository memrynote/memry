import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRetrieveKey = vi.hoisted(() => vi.fn<(entry: unknown) => Promise<Uint8Array | null>>())

vi.mock('../crypto', () => ({
  retrieveKey: (entry: unknown) => mockRetrieveKey(entry)
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { isMemryUserSignedIn } from './auth-state'
import { isMemryUserSignedIn as directExport } from '../auth-state'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('isMemryUserSignedIn', () => {
  beforeEach(() => {
    mockRetrieveKey.mockReset()
  })

  it('is the same function as the main-process module it re-exports', () => {
    // sync/auth-state.ts is a pure barrel. Callers import it from both paths
    // (calendar-handlers from '../auth-state', google sync from
    // '../../sync/auth-state'), and tests mock one path or the other — that
    // only stays honest while both resolve to one implementation.
    expect(isMemryUserSignedIn).toBe(directExport)
  })

  it('reads the sync refresh token, not any other keychain entry', async () => {
    mockRetrieveKey.mockResolvedValue(encode('refresh-token-value'))

    await expect(isMemryUserSignedIn()).resolves.toBe(true)
    expect(mockRetrieveKey).toHaveBeenCalledTimes(1)
    expect(mockRetrieveKey).toHaveBeenCalledWith(KEYCHAIN_ENTRIES.REFRESH_TOKEN)
  })

  describe('signed out', () => {
    it('reports signed out when the keychain has no refresh token', async () => {
      mockRetrieveKey.mockResolvedValue(null)

      await expect(isMemryUserSignedIn()).resolves.toBe(false)
    })

    it('reports signed out for a zero-length token', async () => {
      mockRetrieveKey.mockResolvedValue(new Uint8Array(0))

      await expect(isMemryUserSignedIn()).resolves.toBe(false)
    })

    it('reports signed out for a whitespace-only token', async () => {
      mockRetrieveKey.mockResolvedValue(encode('   \n\t  '))

      await expect(isMemryUserSignedIn()).resolves.toBe(false)
    })
  })

  describe('signed in', () => {
    it('tolerates trailing newlines around a real token', async () => {
      // Keychain backends differ per platform in what they hand back for a
      // value that was stored with a trailing newline (Windows Credential
      // Manager and libsecret have both been seen round-tripping "\r\n").
      // A real token must not read as signed out because of framing.
      mockRetrieveKey.mockResolvedValue(encode('eyJhbGciOi.token\r\n'))

      await expect(isMemryUserSignedIn()).resolves.toBe(true)
    })

    it('decodes the stored bytes as UTF-8', async () => {
      mockRetrieveKey.mockResolvedValue(encode('tökén-ünicode'))

      await expect(isMemryUserSignedIn()).resolves.toBe(true)
    })
  })

  describe('transient keychain failure', () => {
    // retrieveKey throws (it wraps every keychain error) when the OS keychain
    // is locked, the entry is momentarily unreadable, or the dev build's
    // signature is broken. That must NOT surface as "signed out": callers gate
    // Google-calendar sync on this boolean, so a false here would look exactly
    // like a real sign-out and silently stop syncing until restart.
    it('propagates the error instead of reporting the user signed out', async () => {
      mockRetrieveKey.mockRejectedValue(
        new Error('Failed to retrieve key from keychain (refresh-token): unknown error')
      )

      await expect(isMemryUserSignedIn()).rejects.toThrow(/Failed to retrieve key from keychain/)
    })

    it('re-reads the keychain on every call, so a recovered read flips back to signed in', async () => {
      // No caching, no latch: a transient failure or a re-sign-in is picked up
      // on the next call rather than pinning the user to signed out.
      mockRetrieveKey.mockRejectedValueOnce(new Error('keychain unavailable'))
      await expect(isMemryUserSignedIn()).rejects.toThrow('keychain unavailable')

      mockRetrieveKey.mockResolvedValueOnce(null)
      await expect(isMemryUserSignedIn()).resolves.toBe(false)

      mockRetrieveKey.mockResolvedValueOnce(encode('fresh-refresh-token'))
      await expect(isMemryUserSignedIn()).resolves.toBe(true)

      expect(mockRetrieveKey).toHaveBeenCalledTimes(3)
    })
  })
})
