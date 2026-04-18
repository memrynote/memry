import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDataDb, type TestDatabaseResult, type TestDb } from '@tests/utils/test-db'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { findCalendarBindingByRemoteEvent } from './calendar-sources-repository'

describe('findCalendarBindingByRemoteEvent', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  it('returns the active binding matching provider + remoteCalendarId + remoteEventId', () => {
    // #given
    const now = '2026-04-18T09:00:00.000Z'
    db.insert(calendarBindings)
      .values([
        {
          id: 'binding-1',
          sourceType: 'event',
          sourceId: 'event-a',
          provider: 'google',
          remoteCalendarId: 'cal-1',
          remoteEventId: 'evt-1',
          ownershipMode: 'memry_managed',
          writebackMode: 'broad',
          remoteVersion: '"etag-1"',
          lastLocalSnapshot: null,
          archivedAt: null,
          clock: { 'device-a': 1 },
          syncedAt: now,
          createdAt: now,
          modifiedAt: now
        },
        {
          id: 'binding-archived',
          sourceType: 'task',
          sourceId: 'task-a',
          provider: 'google',
          remoteCalendarId: 'cal-1',
          remoteEventId: 'evt-2',
          ownershipMode: 'memry_managed',
          writebackMode: 'broad',
          remoteVersion: null,
          lastLocalSnapshot: null,
          archivedAt: now,
          clock: { 'device-a': 1 },
          syncedAt: now,
          createdAt: now,
          modifiedAt: now
        }
      ])
      .run()

    // #when
    const match = findCalendarBindingByRemoteEvent(db, 'google', 'cal-1', 'evt-1')
    const archivedMatch = findCalendarBindingByRemoteEvent(db, 'google', 'cal-1', 'evt-2')
    const missing = findCalendarBindingByRemoteEvent(db, 'google', 'cal-1', 'evt-missing')

    // #then
    expect(match?.id).toBe('binding-1')
    expect(archivedMatch).toBeUndefined()
    expect(missing).toBeUndefined()
  })
})
