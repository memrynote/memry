import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import keytar from 'keytar'
import {
  CALENDAR_GOOGLE_SETTINGS_DEFAULTS,
  CalendarGoogleSettingsSchema
} from '@memry/contracts/settings-schemas'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DataDb } from '../../database'
import { getSetting, setSetting } from '../../settings/settings-store'
import {
  LEGACY_DEFAULT_ACCOUNT_ID,
  getGoogleCalendarTokens,
  storeGoogleCalendarTokens
} from '../google/keychain'
import {
  calendarProviderSettingsShape,
  isProviderPushEnabled,
  listAgentConsentedProviders,
  readCalendarProviderSettings,
  sanitizeCalendarProviderSettingsUpdates,
  writeCalendarProviderSettings
} from './provider-settings'
import {
  getProviderSecret,
  providerSecretAccountKey,
  providerSecretService,
  setProviderSecret
} from './secrets'

vi.mock('keytar', () => ({
  default: {
    setPassword: vi.fn(),
    getPassword: vi.fn(),
    deletePassword: vi.fn()
  }
}))

// Stored exactly as released builds wrote them. The second predates
// `agentReadEventsConsent`.
const GOOGLE_FIXTURE_CURRENT = {
  defaultTargetCalendarId: 'work@group.calendar.google.com',
  onboardingCompleted: true,
  promoteConfirmDismissed: false,
  pushEventsToGoogle: false,
  agentReadEventsConsent: true
}
const GOOGLE_FIXTURE_BEFORE_CONSENT = {
  defaultTargetCalendarId: null,
  onboardingCompleted: true,
  promoteConfirmDismissed: true,
  pushEventsToGoogle: true
}

describe('per-provider calendar settings (#1394)', () => {
  let dbResult: TestDatabaseResult
  let db: DataDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db as unknown as DataDb
  })

  afterEach(() => {
    dbResult.close()
  })

  it('reads a calendar.google group in today’s shape unchanged', () => {
    setSetting(db, 'calendar.google', JSON.stringify(GOOGLE_FIXTURE_CURRENT))
    expect(CalendarGoogleSettingsSchema.parse(GOOGLE_FIXTURE_CURRENT)).toEqual(
      GOOGLE_FIXTURE_CURRENT
    )
    expect(readCalendarProviderSettings(db, 'google')).toEqual(GOOGLE_FIXTURE_CURRENT)
  })

  it('reads a calendar.google group written before agentReadEventsConsent as "not asked"', () => {
    setSetting(db, 'calendar.google', JSON.stringify(GOOGLE_FIXTURE_BEFORE_CONSENT))
    expect(CalendarGoogleSettingsSchema.parse(GOOGLE_FIXTURE_BEFORE_CONSENT)).toEqual({
      ...GOOGLE_FIXTURE_BEFORE_CONSENT,
      agentReadEventsConsent: null
    })
    expect(readCalendarProviderSettings(db, 'google')).toEqual({
      ...GOOGLE_FIXTURE_BEFORE_CONSENT,
      agentReadEventsConsent: null
    })
  })

  it('keeps Google on its historical key and shape', () => {
    expect(calendarProviderSettingsShape('google')).toMatchObject({
      key: 'calendar.google',
      defaults: CALENDAR_GOOGLE_SETTINGS_DEFAULTS
    })
    expect(calendarProviderSettingsShape('ics')).toMatchObject({
      key: 'calendar.ics',
      defaults: { agentReadEventsConsent: null }
    })
    expect(calendarProviderSettingsShape('microsoft')).toBeNull()
  })

  it('starts ICS consent at null with nothing to migrate', () => {
    setSetting(db, 'calendar.google', JSON.stringify(GOOGLE_FIXTURE_CURRENT))
    expect(readCalendarProviderSettings(db, 'ics')).toEqual({ agentReadEventsConsent: null })
    // Reading never writes: an install that never saw an ICS prompt keeps no key.
    expect(getSetting(db, 'calendar.ics')).toBeNull()
  })

  it('ICS consent is independent of Google consent', () => {
    setSetting(db, 'calendar.google', JSON.stringify(GOOGLE_FIXTURE_CURRENT))
    expect(listAgentConsentedProviders(db, ['google', 'ics'])).toEqual(['google'])
    writeCalendarProviderSettings(db, 'ics', { agentReadEventsConsent: true })
    writeCalendarProviderSettings(db, 'google', { agentReadEventsConsent: false })
    expect(listAgentConsentedProviders(db, ['google', 'ics'])).toEqual(['ics'])
  })

  it('never lets a schema default overwrite a stored answer the update did not mention', () => {
    setSetting(db, 'calendar.google', JSON.stringify(GOOGLE_FIXTURE_CURRENT))
    writeCalendarProviderSettings(db, 'google', { promoteConfirmDismissed: true })
    expect(readCalendarProviderSettings(db, 'google')).toEqual({
      ...GOOGLE_FIXTURE_CURRENT,
      promoteConfirmDismissed: true
    })
  })

  it('drops unknown fields and rejects invalid values', () => {
    expect(
      sanitizeCalendarProviderSettingsUpdates('ics', { agentReadEventsConsent: true, junk: 1 })
    ).toEqual({ agentReadEventsConsent: true })
    expect(sanitizeCalendarProviderSettingsUpdates('ics', { agentReadEventsConsent: 'yes' })).toBe(
      null
    )
    expect(sanitizeCalendarProviderSettingsUpdates('microsoft', {})).toBeNull()
  })

  it('reads the one-way switch per provider, Google from pushEventsToGoogle', () => {
    expect(isProviderPushEnabled(db, 'google')).toBe(true)
    setSetting(db, 'calendar.google', JSON.stringify(GOOGLE_FIXTURE_CURRENT))
    expect(isProviderPushEnabled(db, 'google')).toBe(false)
    // A provider without a write path never pushes, whatever is stored.
    setSetting(db, 'calendar.ics', JSON.stringify({ pushEventsToProvider: true }))
    expect(isProviderPushEnabled(db, 'ics')).toBe(false)
  })
})

describe('per-provider credentials (#1394)', () => {
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    delete process.env.MEMRY_DEVICE
    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, value) => {
      store.set(`${service}:${account}`, value)
    })
    vi.mocked(keytar.getPassword).mockImplementation(
      async (service, account) => store.get(`${service}:${account}`) ?? null
    )
    vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) =>
      store.delete(`${service}:${account}`)
    )
  })

  it('keeps Google’s service and account keys verbatim', () => {
    expect(providerSecretService('google')).toBe('com.memry.calendar.google')
    expect(providerSecretAccountKey(LEGACY_DEFAULT_ACCOUNT_ID, 'refresh-token')).toBe(
      'refresh-token-__memry_default__'
    )
    process.env.MEMRY_DEVICE = 'b'
    expect(providerSecretAccountKey('me@example.com', 'access-token')).toBe(
      'access-token-me@example.com-b'
    )
    delete process.env.MEMRY_DEVICE
  })

  it('resolves a pre-existing Google secret, including the legacy default account', async () => {
    await storeGoogleCalendarTokens({
      accountId: LEGACY_DEFAULT_ACCOUNT_ID,
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh'
    })
    expect(await getProviderSecret('google', LEGACY_DEFAULT_ACCOUNT_ID, 'refresh-token')).toBe(
      'legacy-refresh'
    )
    expect(await getGoogleCalendarTokens(LEGACY_DEFAULT_ACCOUNT_ID)).toEqual({
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh'
    })
  })

  it('stores a CalDAV app password under its own service, never Google’s', async () => {
    await setProviderSecret('caldav', 'https://dav.example.com/|me', 'password', ' pass word ')
    expect(store.get('com.memry.calendar.caldav:password-https://dav.example.com/|me')).toBe(
      ' pass word '
    )
    expect([...store.keys()].some((key) => key.startsWith('com.memry.calendar.google'))).toBe(false)
    await setProviderSecret('caldav', 'https://dav.example.com/|me', 'password', null)
    expect(await getProviderSecret('caldav', 'https://dav.example.com/|me', 'password')).toBeNull()
  })

  it('refuses a provider id that could escape its service namespace', () => {
    expect(() => providerSecretService('google.evil')).toThrow()
  })
})
