import sodium from 'libsodium-wrappers-sumo'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./oauth', () => ({
  listGoogleAccountIds: vi.fn()
}))

vi.mock('./keychain', () => ({
  getGoogleCalendarTokens: vi.fn(),
  storeGoogleCalendarRefreshToken: vi.fn()
}))

import { listGoogleAccountIds } from './oauth'
import { getGoogleCalendarTokens, storeGoogleCalendarRefreshToken } from './keychain'
import {
  collectGoogleProviderAuthTransfer,
  decryptGoogleProviderAuthTransfer,
  encryptGoogleProviderAuthTransfer,
  persistImportedGoogleProviderAuth
} from './provider-auth-transfer'

describe('google provider auth transfer', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('collects refresh tokens for every google account with local auth', async () => {
    vi.mocked(listGoogleAccountIds).mockReturnValue(['account-a', 'account-b', 'account-c'])
    vi.mocked(getGoogleCalendarTokens)
      .mockResolvedValueOnce({ accessToken: 'access-a', refreshToken: 'refresh-a' })
      .mockResolvedValueOnce({ accessToken: null, refreshToken: null })
      .mockResolvedValueOnce({ accessToken: 'access-c', refreshToken: 'refresh-c' })

    const transfer = await collectGoogleProviderAuthTransfer({} as never)

    expect(transfer).toEqual({
      version: 1,
      providers: [
        { provider: 'google', accountId: 'account-a', refreshToken: 'refresh-a' },
        { provider: 'google', accountId: 'account-c', refreshToken: 'refresh-c' }
      ]
    })
  })

  it('returns null when no account has a refresh token to export', async () => {
    vi.mocked(listGoogleAccountIds).mockReturnValue(['account-a'])
    vi.mocked(getGoogleCalendarTokens).mockResolvedValue({ accessToken: 'stale', refreshToken: null })

    await expect(collectGoogleProviderAuthTransfer({} as never)).resolves.toBeNull()
  })

  it('round-trips an encrypted transfer bound to the linking session id', () => {
    const encKey = sodium.randombytes_buf(32)
    const macKey = sodium.randombytes_buf(32)
    const transfer = {
      version: 1 as const,
      providers: [{ provider: 'google' as const, accountId: 'account-a', refreshToken: 'refresh-a' }]
    }

    const encrypted = encryptGoogleProviderAuthTransfer({
      transfer,
      sessionId: 'session-1',
      encKey,
      macKey
    })

    const decrypted = decryptGoogleProviderAuthTransfer({
      ...encrypted,
      sessionId: 'session-1',
      encKey,
      macKey
    })

    expect(decrypted).toEqual(transfer)
  })

  it('rejects decryption when the session id changes', () => {
    const encKey = sodium.randombytes_buf(32)
    const macKey = sodium.randombytes_buf(32)

    const encrypted = encryptGoogleProviderAuthTransfer({
      transfer: {
        version: 1,
        providers: [{ provider: 'google', accountId: 'account-a', refreshToken: 'refresh-a' }]
      },
      sessionId: 'session-1',
      encKey,
      macKey
    })

    expect(() =>
      decryptGoogleProviderAuthTransfer({
        ...encrypted,
        sessionId: 'session-2',
        encKey,
        macKey
      })
    ).toThrow('Provider auth confirmation failed')
  })

  it('rejects decryption when the confirmation mac is tampered', () => {
    const encKey = sodium.randombytes_buf(32)
    const macKey = sodium.randombytes_buf(32)

    const encrypted = encryptGoogleProviderAuthTransfer({
      transfer: {
        version: 1,
        providers: [{ provider: 'google', accountId: 'account-a', refreshToken: 'refresh-a' }]
      },
      sessionId: 'session-1',
      encKey,
      macKey
    })

    expect(() =>
      decryptGoogleProviderAuthTransfer({
        ...encrypted,
        providerAuthConfirm: sodium.to_base64(
          sodium.randombytes_buf(sodium.crypto_auth_BYTES),
          sodium.base64_variants.ORIGINAL
        ),
        sessionId: 'session-1',
        encKey,
        macKey
      })
    ).toThrow('Provider auth confirmation failed')
  })

  it('rejects unsupported transfer versions before decryption', () => {
    const encKey = sodium.randombytes_buf(32)
    const macKey = sodium.randombytes_buf(32)

    const encrypted = encryptGoogleProviderAuthTransfer({
      transfer: {
        version: 1,
        providers: []
      },
      sessionId: 'session-1',
      encKey,
      macKey
    })

    expect(() =>
      decryptGoogleProviderAuthTransfer({
        ...encrypted,
        providerAuthVersion: 2,
        sessionId: 'session-1',
        encKey,
        macKey
      })
    ).toThrow('Unsupported provider auth transfer version: 2')
  })

  it('allows an empty provider list', () => {
    const encKey = sodium.randombytes_buf(32)
    const macKey = sodium.randombytes_buf(32)

    const encrypted = encryptGoogleProviderAuthTransfer({
      transfer: {
        version: 1,
        providers: []
      },
      sessionId: 'session-1',
      encKey,
      macKey
    })

    const decrypted = decryptGoogleProviderAuthTransfer({
      ...encrypted,
      sessionId: 'session-1',
      encKey,
      macKey
    })

    expect(decrypted).toEqual({ version: 1, providers: [] })
  })

  it('persists imported refresh tokens and reports per-account write failures', async () => {
    vi.mocked(storeGoogleCalendarRefreshToken)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('keychain unavailable'))

    const result = await persistImportedGoogleProviderAuth({
      version: 1,
      providers: [
        { provider: 'google', accountId: 'account-a', refreshToken: 'refresh-a' },
        { provider: 'google', accountId: 'account-b', refreshToken: 'refresh-b' }
      ]
    })

    expect(result).toEqual({
      importedAccountIds: ['account-a'],
      failedImports: [{ accountId: 'account-b', error: 'keychain unavailable' }]
    })
    expect(storeGoogleCalendarRefreshToken).toHaveBeenNthCalledWith(1, {
      accountId: 'account-a',
      refreshToken: 'refresh-a'
    })
    expect(storeGoogleCalendarRefreshToken).toHaveBeenNthCalledWith(2, {
      accountId: 'account-b',
      refreshToken: 'refresh-b'
    })
  })
})
