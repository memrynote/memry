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
  clearGoogleCalendarTokens,
  getAccountKey,
  getGoogleCalendarTokens,
  hasGoogleCalendarTokens,
  storeGoogleCalendarRefreshToken,
  storeGoogleCalendarTokens
} from './keychain'

describe('google calendar keychain — multi-account partitioning', () => {
  const keytarStore = new Map<string, string>()

  beforeEach(() => {
    vi.clearAllMocks()
    keytarStore.clear()
    delete process.env.MEMRY_DEVICE

    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, value) => {
      keytarStore.set(`${service}:${account}`, value)
    })
    vi.mocked(keytar.getPassword).mockImplementation(async (service, account) => {
      return keytarStore.get(`${service}:${account}`) ?? null
    })
    vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) => {
      return keytarStore.delete(`${service}:${account}`)
    })
  })

  afterEach(() => {
    delete process.env.MEMRY_DEVICE
  })

  it('stores tokens for different accountIds in distinct keytar slots', async () => {
    await storeGoogleCalendarTokens({
      accountId: 'alice@example.com',
      accessToken: 'alice-access',
      refreshToken: 'alice-refresh'
    })
    await storeGoogleCalendarTokens({
      accountId: 'bob@example.com',
      accessToken: 'bob-access',
      refreshToken: 'bob-refresh'
    })

    expect(await getGoogleCalendarTokens('alice@example.com')).toEqual({
      accessToken: 'alice-access',
      refreshToken: 'alice-refresh'
    })
    expect(await getGoogleCalendarTokens('bob@example.com')).toEqual({
      accessToken: 'bob-access',
      refreshToken: 'bob-refresh'
    })

    // Four distinct (service, account) slots written: 2 accounts * 2 token kinds.
    const writeCalls = vi.mocked(keytar.setPassword).mock.calls
    const accounts = writeCalls.map((call) => call[1])
    expect(new Set(accounts).size).toBe(4)
  })

  it('returns null tokens when accountId has no stored credentials', async () => {
    const tokens = await getGoogleCalendarTokens('nobody@example.com')
    expect(tokens).toEqual({ accessToken: null, refreshToken: null })
    expect(await hasGoogleCalendarTokens('nobody@example.com')).toBe(false)
  })

  it('clearing one account does not affect another account', async () => {
    await storeGoogleCalendarTokens({
      accountId: 'alice@example.com',
      accessToken: 'a1',
      refreshToken: 'r1'
    })
    await storeGoogleCalendarTokens({
      accountId: 'bob@example.com',
      accessToken: 'a2',
      refreshToken: 'r2'
    })

    await clearGoogleCalendarTokens('alice@example.com')

    expect(await getGoogleCalendarTokens('alice@example.com')).toEqual({
      accessToken: null,
      refreshToken: null
    })
    expect(await getGoogleCalendarTokens('bob@example.com')).toEqual({
      accessToken: 'a2',
      refreshToken: 'r2'
    })
    expect(await hasGoogleCalendarTokens('alice@example.com')).toBe(false)
    expect(await hasGoogleCalendarTokens('bob@example.com')).toBe(true)
  })

  it('getAccountKey returns a deterministic keytar account string including accountId and kind', () => {
    const aliceAccess = getAccountKey('alice@example.com', 'access-token')
    const aliceRefresh = getAccountKey('alice@example.com', 'refresh-token')
    const bobAccess = getAccountKey('bob@example.com', 'access-token')

    expect(aliceAccess).toContain('alice@example.com')
    expect(aliceAccess).toContain('access-token')
    expect(aliceRefresh).toContain('refresh-token')
    expect(aliceAccess).not.toEqual(bobAccess)
    // Kind substring stable for pattern-match assertions elsewhere.
    expect(aliceAccess.startsWith('access-token')).toBe(true)
    expect(aliceRefresh.startsWith('refresh-token')).toBe(true)
  })

  it('respects MEMRY_DEVICE env suffix on top of accountId partitioning', async () => {
    process.env.MEMRY_DEVICE = 'devA'

    await storeGoogleCalendarTokens({
      accountId: 'alice@example.com',
      accessToken: 'devA-alice-access',
      refreshToken: 'devA-alice-refresh'
    })

    const writes = vi.mocked(keytar.setPassword).mock.calls
    for (const [, account] of writes) {
      expect(account).toContain('alice@example.com')
      expect(account).toContain('devA')
    }
  })

  it('storing an imported refresh token clears any stale access token on this device', async () => {
    await storeGoogleCalendarTokens({
      accountId: 'alice@example.com',
      accessToken: 'stale-access',
      refreshToken: 'old-refresh'
    })

    await storeGoogleCalendarRefreshToken({
      accountId: 'alice@example.com',
      refreshToken: 'imported-refresh'
    })

    expect(await getGoogleCalendarTokens('alice@example.com')).toEqual({
      accessToken: null,
      refreshToken: 'imported-refresh'
    })
  })
})
