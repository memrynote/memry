import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import keytar from 'keytar'

vi.mock('keytar', () => ({
  default: {
    setPassword: vi.fn(),
    getPassword: vi.fn(),
    deletePassword: vi.fn()
  }
}))

import {
  calendarCredentialService,
  deleteProviderSecret,
  getProviderAccountKey,
  getProviderSecret,
  setProviderSecret
} from './credentials'
import { LEGACY_DEFAULT_ACCOUNT_ID, getGoogleCalendarTokens } from '../providers/google/keychain'

describe('per-provider calendar credentials (#1394)', () => {
  const keytarStore = new Map<string, string>()

  beforeEach(() => {
    vi.clearAllMocks()
    keytarStore.clear()
    delete process.env.MEMRY_DEVICE

    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, value) => {
      keytarStore.set(`${service}:${account}`, value)
    })
    vi.mocked(keytar.getPassword).mockImplementation(
      async (service, account) => keytarStore.get(`${service}:${account}`) ?? null
    )
    vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) =>
      keytarStore.delete(`${service}:${account}`)
    )
  })

  afterEach(() => {
    delete process.env.MEMRY_DEVICE
  })

  it('gives google the exact service name the Google-only build hard-coded', () => {
    // A different string here strands every credential already on disk.
    expect(calendarCredentialService('google')).toBe('com.memry.calendar.google')
    expect(calendarCredentialService('caldav')).toBe('com.memry.calendar.caldav')
    expect(calendarCredentialService('microsoft')).toBe('com.memry.calendar.microsoft')
  })

  it('preserves the account-key scheme, dev-profile suffix included', () => {
    expect(getProviderAccountKey('alice@example.com', 'refresh-token')).toBe(
      'refresh-token-alice@example.com'
    )

    process.env.MEMRY_DEVICE = 'b'
    expect(getProviderAccountKey('alice@example.com', 'refresh-token')).toBe(
      'refresh-token-alice@example.com-b'
    )
  })

  it('rejects an empty provider id or account id rather than writing a bare key', async () => {
    expect(() => calendarCredentialService('')).toThrow(/non-empty providerId/)
    expect(() => getProviderAccountKey('  ', 'password')).toThrow(/non-empty accountId/)
  })

  it('resolves a credential a previous Google-only build wrote', async () => {
    // #given the exact keytar entry the old code path produced
    keytarStore.set('com.memry.calendar.google:refresh-token-alice@example.com', 'old-refresh')

    // #then both the neutral reader and the Google accessor find it
    expect(
      await getProviderSecret({
        providerId: 'google',
        accountId: 'alice@example.com',
        kind: 'refresh-token'
      })
    ).toBe('old-refresh')
    expect(await getGoogleCalendarTokens('alice@example.com')).toEqual({
      accessToken: null,
      refreshToken: 'old-refresh'
    })
  })

  it('resolves a pre-multi-account credential stored under the legacy account id', async () => {
    keytarStore.set(
      `com.memry.calendar.google:refresh-token-${LEGACY_DEFAULT_ACCOUNT_ID}`,
      'legacy-refresh'
    )

    expect(await getGoogleCalendarTokens(LEGACY_DEFAULT_ACCOUNT_ID)).toEqual({
      accessToken: null,
      refreshToken: 'legacy-refresh'
    })
  })

  it('partitions two providers that share an account id', async () => {
    await setProviderSecret({
      providerId: 'google',
      accountId: 'alice@example.com',
      kind: 'refresh-token',
      value: 'google-refresh'
    })
    await setProviderSecret({
      providerId: 'caldav',
      accountId: 'alice@example.com',
      kind: 'password',
      value: 'app-password'
    })

    expect(
      await getProviderSecret({
        providerId: 'google',
        accountId: 'alice@example.com',
        kind: 'refresh-token'
      })
    ).toBe('google-refresh')
    expect(
      await getProviderSecret({
        providerId: 'caldav',
        accountId: 'alice@example.com',
        kind: 'password'
      })
    ).toBe('app-password')

    // Disconnecting CalDAV must not log the user out of Google.
    await deleteProviderSecret({
      providerId: 'caldav',
      accountId: 'alice@example.com',
      kind: 'password'
    })
    expect(
      await getProviderSecret({
        providerId: 'google',
        accountId: 'alice@example.com',
        kind: 'refresh-token'
      })
    ).toBe('google-refresh')
  })

  it('treats an empty value as a delete rather than storing a blank secret', async () => {
    await setProviderSecret({
      providerId: 'caldav',
      accountId: 'alice@example.com',
      kind: 'password',
      value: 'app-password'
    })
    await setProviderSecret({
      providerId: 'caldav',
      accountId: 'alice@example.com',
      kind: 'password',
      value: '   '
    })

    expect(
      await getProviderSecret({
        providerId: 'caldav',
        accountId: 'alice@example.com',
        kind: 'password'
      })
    ).toBeNull()
  })
  describe('keychain failures name the provider', () => {
    it('wraps a write failure rather than surfacing a bare keytar error', async () => {
      vi.mocked(keytar.setPassword).mockRejectedValueOnce(new Error('keychain locked'))

      await expect(
        setProviderSecret({
          providerId: 'caldav',
          accountId: 'alice@example.com',
          kind: 'password',
          value: 'app-password'
        })
      ).rejects.toThrow(/Failed to store caldav calendar credential .*keychain locked/)
    })

    it('wraps a delete failure the same way', async () => {
      vi.mocked(keytar.deletePassword).mockRejectedValueOnce(new Error('keychain locked'))

      await expect(
        deleteProviderSecret({
          providerId: 'google',
          accountId: 'alice@example.com',
          kind: 'refresh-token'
        })
      ).rejects.toThrow(/Failed to delete google calendar credential/)
    })

    it('reports a non-Error rejection as an unknown error rather than "undefined"', async () => {
      vi.mocked(keytar.setPassword).mockRejectedValueOnce('nope')

      await expect(
        setProviderSecret({
          providerId: 'ics',
          accountId: 'alice@example.com',
          kind: 'password',
          value: 'x'
        })
      ).rejects.toThrow(/unknown error/)
    })
  })
})
