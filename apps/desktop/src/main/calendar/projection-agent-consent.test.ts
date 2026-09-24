import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DataDb, IndexDb } from '../database'
import { getCalendarRangeProjection } from './projection'

const NOW = '2026-09-24T08:00:00.000Z'

function seed(db: TestDatabaseResult['db'], provider: string): void {
  db.insert(calendarSources)
    .values({
      id: `${provider}-calendar:1`,
      provider,
      kind: 'calendar',
      remoteId: `${provider}-remote`,
      title: `${provider} calendar`,
      isSelected: true,
      syncStatus: 'ok',
      createdAt: NOW,
      modifiedAt: NOW
    })
    .run()
  db.insert(calendarExternalEvents)
    .values({
      id: `${provider}-event`,
      sourceId: `${provider}-calendar:1`,
      remoteEventId: `${provider}-remote-event`,
      title: `${provider} event`,
      startAt: '2026-09-24T09:00:00.000Z',
      endAt: '2026-09-24T10:00:00.000Z',
      isAllDay: false,
      status: 'confirmed',
      createdAt: NOW,
      modifiedAt: NOW
    })
    .run()
}

describe('agent read allow-list on the range projection (#1394)', () => {
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  beforeEach(() => {
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    seed(dataDb.db, 'google')
    seed(dataDb.db, 'ics')
  })

  afterEach(() => {
    dataDb.close()
    indexDb.close()
  })

  function externalProvidersIn(input: {
    includeExternal?: boolean
    externalProviders?: string[]
  }): string[] {
    const { items } = getCalendarRangeProjection(
      dataDb.db as unknown as DataDb,
      indexDb.db as unknown as IndexDb,
      {
        startAt: '2026-09-24T00:00:00.000Z',
        endAt: '2026-09-25T00:00:00.000Z',
        includeUnselectedSources: false,
        ...input
      },
      []
    )
    return items
      .filter((item) => item.sourceType === 'external_event')
      .map((item) => item.source.provider ?? '')
      .sort()
  }

  it('keeps ICS events out while only Google is consented', () => {
    expect(externalProvidersIn({ includeExternal: true, externalProviders: ['google'] })).toEqual([
      'google'
    ])
  })

  it('lets ICS events through once ICS is consented, whatever Google answered', () => {
    expect(externalProvidersIn({ includeExternal: true, externalProviders: ['ics'] })).toEqual([
      'ics'
    ])
  })

  it('an empty allow-list means no external events at all', () => {
    expect(externalProvidersIn({ includeExternal: true, externalProviders: [] })).toEqual([])
  })

  it('an older renderer without the allow-list keeps today’s behaviour', () => {
    expect(externalProvidersIn({})).toEqual(['google', 'ics'])
    expect(externalProvidersIn({ includeExternal: false })).toEqual([])
  })
})
