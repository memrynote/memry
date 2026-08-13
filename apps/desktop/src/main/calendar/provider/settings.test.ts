import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { settings } from '@memry/db-schema/schema/settings'
import {
  CalendarGoogleSettingsSchema,
  CalendarProviderSettingsSchema
} from '@memry/contracts/settings-schemas'
import {
  asClientDb,
  createTestDataDb,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import { getSetting } from '../../settings/settings-store'
import {
  calendarProviderSettingsKey,
  hasAgentReadConsent,
  readCalendarProviderSettings,
  writeCalendarProviderSettings
} from './settings'

/**
 * The exact JSON an install running the Google-only build wrote to
 * `settings['calendar.google']`. Nothing here may need a migration.
 */
const LEGACY_GOOGLE_ROW = {
  defaultTargetCalendarId: 'work@group.calendar.google.com',
  onboardingCompleted: true,
  promoteConfirmDismissed: true,
  pushEventsToGoogle: false,
  agentReadEventsConsent: true
}

/** Written before `agentReadEventsConsent` shipped — the key is simply absent. */
const OLDER_GOOGLE_ROW = {
  defaultTargetCalendarId: null,
  onboardingCompleted: true,
  promoteConfirmDismissed: false,
  pushEventsToGoogle: true
}

describe('per-provider calendar settings (#1394)', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  function seedGroup(key: string, value: unknown): void {
    db.insert(settings)
      .values({ key, value: JSON.stringify(value), modifiedAt: '2026-04-12T09:00:00.000Z' })
      .run()
  }

  describe('the google group is frozen in its historic shape', () => {
    it('parses a settings fixture written by the Google-only build, unchanged', () => {
      expect(CalendarGoogleSettingsSchema.safeParse(LEGACY_GOOGLE_ROW).success).toBe(true)
      expect(CalendarGoogleSettingsSchema.safeParse(OLDER_GOOGLE_ROW).success).toBe(true)
    })

    it('reads that fixture back through the neutral accessor', () => {
      seedGroup('calendar.google', LEGACY_GOOGLE_ROW)

      expect(readCalendarProviderSettings(asClientDb(db), 'google')).toEqual({
        defaultTargetCalendarId: 'work@group.calendar.google.com',
        onboardingCompleted: true,
        promoteConfirmDismissed: true,
        // The one translated key: stored as pushEventsToGoogle, read as neutral.
        pushEventsToProvider: false,
        agentReadEventsConsent: true
      })
    })

    it('defaults a pre-consent row to "not asked", not to allowed', () => {
      seedGroup('calendar.google', OLDER_GOOGLE_ROW)

      const read = readCalendarProviderSettings(asClientDb(db), 'google')
      expect(read.agentReadEventsConsent).toBeNull()
      expect(hasAgentReadConsent(asClientDb(db), 'google')).toBe(false)
    })

    it('writes back the legacy key and adds no new ones', () => {
      seedGroup('calendar.google', LEGACY_GOOGLE_ROW)

      writeCalendarProviderSettings(asClientDb(db), 'google', { pushEventsToProvider: true })

      const raw = JSON.parse(getSetting(asClientDb(db), 'calendar.google') ?? '{}') as Record<
        string,
        unknown
      >
      expect(raw.pushEventsToGoogle).toBe(true)
      expect(raw).not.toHaveProperty('pushEventsToProvider')
      expect(Object.keys(raw).sort()).toEqual(Object.keys(LEGACY_GOOGLE_ROW).sort())
    })

    it('keeps the historic group key', () => {
      expect(calendarProviderSettingsKey('google')).toBe('calendar.google')
    })
  })

  describe('a new provider gets its own group in the neutral shape', () => {
    it('stores under calendar.<providerId> and never touches google', () => {
      seedGroup('calendar.google', LEGACY_GOOGLE_ROW)

      writeCalendarProviderSettings(asClientDb(db), 'caldav', {
        defaultTargetCalendarId: 'https://caldav.fastmail.com/personal',
        pushEventsToProvider: false
      })

      const caldav = readCalendarProviderSettings(asClientDb(db), 'caldav')
      expect(caldav.defaultTargetCalendarId).toBe('https://caldav.fastmail.com/personal')
      expect(caldav.pushEventsToProvider).toBe(false)
      expect(CalendarProviderSettingsSchema.safeParse(caldav).success).toBe(true)

      // Google's row is untouched — no migration, no cross-writes.
      expect(JSON.parse(getSetting(asClientDb(db), 'calendar.google') ?? '{}')).toEqual(
        LEGACY_GOOGLE_ROW
      )
    })

    it('starts every provider at "agent may not read", including ones never written', () => {
      expect(hasAgentReadConsent(asClientDb(db), 'ics')).toBe(false)
      expect(hasAgentReadConsent(asClientDb(db), 'caldav')).toBe(false)

      writeCalendarProviderSettings(asClientDb(db), 'ics', { agentReadEventsConsent: false })
      expect(hasAgentReadConsent(asClientDb(db), 'ics')).toBe(false)

      writeCalendarProviderSettings(asClientDb(db), 'ics', { agentReadEventsConsent: true })
      expect(hasAgentReadConsent(asClientDb(db), 'ics')).toBe(true)
      // Consenting to one provider says nothing about another.
      expect(hasAgentReadConsent(asClientDb(db), 'caldav')).toBe(false)
    })

    it('falls back to defaults when the stored group is corrupt', () => {
      db.insert(settings)
        .values({
          key: 'calendar.caldav',
          value: 'not json',
          modifiedAt: '2026-04-12T09:00:00.000Z'
        })
        .run()

      expect(readCalendarProviderSettings(asClientDb(db), 'caldav').pushEventsToProvider).toBe(true)
      expect(hasAgentReadConsent(asClientDb(db), 'caldav')).toBe(false)
    })
  })
})
