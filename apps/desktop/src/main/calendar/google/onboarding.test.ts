import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDataDb, type TestDatabaseResult, type TestDb } from '@tests/utils/test-db'
import { settings } from '@memry/db-schema/schema/settings'
import { listGoogleCalendars, setDefaultGoogleCalendar } from './onboarding'
import type { GoogleCalendarDescriptor, GoogleCalendarClient } from '../types'
import type { DataDb } from '../../database'

function makeClient(
  calendars: GoogleCalendarDescriptor[]
): Pick<GoogleCalendarClient, 'listCalendars'> {
  return {
    listCalendars: vi.fn(async () => calendars)
  }
}

function writeSettings(
  db: TestDb,
  value: {
    defaultTargetCalendarId?: string | null
    onboardingCompleted?: boolean
    promoteConfirmDismissed?: boolean
  }
): void {
  const merged = {
    defaultTargetCalendarId: null,
    onboardingCompleted: false,
    promoteConfirmDismissed: false,
    ...value
  }
  db.insert(settings)
    .values({
      key: 'calendar.google',
      value: JSON.stringify(merged),
      modifiedAt: '2026-05-01T08:00:00.000Z'
    })
    .run()
}

describe('listGoogleCalendars (M2)', () => {
  let dbResult: TestDatabaseResult
  let db: DataDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db as unknown as DataDb
  })

  afterEach(() => {
    dbResult.close()
  })

  it('#given a signed-in user #when called #then returns the client calendar list with primary resolved and currentDefaultId from settings', async () => {
    const primary: GoogleCalendarDescriptor = {
      id: 'primary@group.calendar.google.com',
      title: 'user@example.com',
      timezone: 'UTC',
      color: '#1a73e8',
      isPrimary: true
    }
    const work: GoogleCalendarDescriptor = {
      id: 'work@group.calendar.google.com',
      title: 'Work',
      timezone: 'UTC',
      color: '#0b8043',
      isPrimary: false
    }
    const client = makeClient([work, primary])
    writeSettings(dbResult.db, { defaultTargetCalendarId: 'work@group.calendar.google.com' })

    const result = await listGoogleCalendars(db, client)

    expect(client.listCalendars).toHaveBeenCalledTimes(1)
    expect(result.calendars).toEqual([work, primary])
    expect(result.primary).toEqual(primary)
    expect(result.currentDefaultId).toBe('work@group.calendar.google.com')
  })

  it('#given no primary in the list #when called #then primary is null', async () => {
    const onlyWork: GoogleCalendarDescriptor = {
      id: 'work@group.calendar.google.com',
      title: 'Work',
      timezone: 'UTC',
      color: null,
      isPrimary: false
    }
    const client = makeClient([onlyWork])

    const result = await listGoogleCalendars(db, client)

    expect(result.primary).toBeNull()
    expect(result.currentDefaultId).toBeNull()
  })

  it('#given no settings row yet #when called #then currentDefaultId is null (defaults)', async () => {
    const client = makeClient([])
    const result = await listGoogleCalendars(db, client)

    expect(result.calendars).toEqual([])
    expect(result.currentDefaultId).toBeNull()
  })
})

describe('setDefaultGoogleCalendar (M2)', () => {
  let dbResult: TestDatabaseResult
  let db: DataDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db as unknown as DataDb
  })

  afterEach(() => {
    dbResult.close()
  })

  it('#given a user picks a calendar #when called #then defaultTargetCalendarId persists and onboardingCompleted flips to true', () => {
    const result = setDefaultGoogleCalendar(db, {
      calendarId: 'primary@group.calendar.google.com',
      markOnboardingComplete: true
    })

    expect(result).toEqual({ success: true })
    const row = dbResult.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('calendar.google') as { value: string } | undefined
    expect(row).toBeDefined()
    expect(JSON.parse(row!.value)).toEqual({
      defaultTargetCalendarId: 'primary@group.calendar.google.com',
      onboardingCompleted: true,
      promoteConfirmDismissed: false
    })
  })

  it('#given the user skips onboarding #when called with null and markOnboardingComplete=true #then stores null default but marks completed', () => {
    const result = setDefaultGoogleCalendar(db, {
      calendarId: null,
      markOnboardingComplete: true
    })

    expect(result).toEqual({ success: true })
    const row = dbResult.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('calendar.google') as { value: string } | undefined
    expect(JSON.parse(row!.value)).toMatchObject({
      defaultTargetCalendarId: null,
      onboardingCompleted: true
    })
  })

  it('#given the user changes the default later #when markOnboardingComplete=false #then preserves previous onboardingCompleted flag', () => {
    // First run: onboarding completes
    setDefaultGoogleCalendar(db, {
      calendarId: 'primary@group.calendar.google.com',
      markOnboardingComplete: true
    })
    // Second run: user changes default from a settings screen; don't reset onboarding
    setDefaultGoogleCalendar(db, {
      calendarId: 'work@group.calendar.google.com',
      markOnboardingComplete: false
    })

    const row = dbResult.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('calendar.google') as { value: string } | undefined
    expect(JSON.parse(row!.value)).toMatchObject({
      defaultTargetCalendarId: 'work@group.calendar.google.com',
      onboardingCompleted: true
    })
  })
})
