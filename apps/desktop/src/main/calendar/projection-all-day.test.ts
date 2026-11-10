import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../main/database'
import { getCalendarRangeProjection } from './projection'

// Providers store an all-day date as UTC midnight; the calendar reads projection
// instants in local time, so the projection must hand back local midnights.
describe.each(['America/Chicago', 'Asia/Seoul'])('all-day projection in %s', (timeZone) => {
  let dbResult: TestDatabaseResult
  let indexDbResult: TestDatabaseResult
  let db: TestDb
  const originalTz = process.env.TZ

  beforeEach(() => {
    process.env.TZ = timeZone
    dbResult = createTestDataDb()
    db = dbResult.db
    indexDbResult = createTestIndexDb()
    db.insert(calendarSources)
      .values({
        id: 'source',
        provider: 'google',
        kind: 'calendar',
        remoteId: 'primary',
        title: 'Work',
        isSelected: true
      })
      .run()
  })

  afterEach(() => {
    dbResult.close()
    indexDbResult.close()
    process.env.TZ = originalTz
  })

  function project(day: number) {
    return getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDbResult.db,
      {
        startAt: new Date(2026, 10, day).toISOString(),
        endAt: new Date(2026, 10, day + 1).toISOString(),
        includeUnselectedSources: false
      },
      []
    ).items
  }

  it('keeps a one-day provider event on its own day', () => {
    db.insert(calendarExternalEvents)
      .values({
        id: 'google-all-day',
        sourceId: 'source',
        remoteEventId: 'remote',
        title: 'Holiday',
        startAt: '2026-11-10T00:00:00.000Z',
        endAt: '2026-11-11T00:00:00.000Z',
        isAllDay: true
      })
      .run()

    expect(project(10)).toEqual([
      expect.objectContaining({
        sourceId: 'google-all-day',
        startAt: new Date(2026, 10, 10).toISOString(),
        endAt: new Date(2026, 10, 11).toISOString()
      })
    ])
    expect(project(9)).toEqual([])
    expect(project(11)).toEqual([])
  })

  it('keeps a memrynote event saved at local midnight on its day', () => {
    db.insert(calendarEvents)
      .values({
        id: 'native-all-day',
        title: 'Offsite',
        startAt: new Date(2026, 10, 10).toISOString(),
        endAt: new Date(2026, 10, 10).toISOString(),
        isAllDay: true
      })
      .run()

    expect(project(10)).toEqual([
      expect.objectContaining({
        sourceId: 'native-all-day',
        startAt: new Date(2026, 10, 10).toISOString(),
        endAt: new Date(2026, 10, 10).toISOString()
      })
    ])
  })
})
