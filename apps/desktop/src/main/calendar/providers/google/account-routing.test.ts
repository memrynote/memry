import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { createTestDataDb, type TestDatabaseResult, type TestDb } from '@tests/utils/test-db'

vi.mock('./oauth', () => ({
  resolveDefaultGoogleAccountId: vi.fn((_db: unknown) => 'fallback-default@example.com')
}))

import { resolveTargetGoogleAccountId } from './account-routing'

const NOW = '2026-04-19T10:00:00.000Z'

function seedAccountAndCalendar(
  db: TestDb,
  accountId: string,
  calendarRemoteId: string,
  calendarSourceId: string
): void {
  db.insert(calendarSources)
    .values({
      id: `google-account:${accountId}`,
      provider: 'google',
      kind: 'account',
      accountId,
      remoteId: accountId,
      title: accountId,
      timezone: 'UTC',
      color: null,
      isPrimary: false,
      isSelected: false,
      isMemryManaged: false,
      syncStatus: 'ok',
      metadata: null,
      createdAt: NOW,
      modifiedAt: NOW
    })
    .run()
  db.insert(calendarSources)
    .values({
      id: calendarSourceId,
      provider: 'google',
      kind: 'calendar',
      accountId,
      remoteId: calendarRemoteId,
      title: `${accountId}/${calendarRemoteId}`,
      timezone: 'UTC',
      color: null,
      isPrimary: false,
      isSelected: true,
      isMemryManaged: false,
      syncStatus: 'ok',
      metadata: null,
      createdAt: NOW,
      modifiedAt: NOW
    })
    .run()
}

describe('resolveTargetGoogleAccountId (M6 T4)', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  it('routes through existingBinding.remoteCalendarId when present', () => {
    // #given two account+calendar pairs; binding points at account B's calendar
    seedAccountAndCalendar(db, 'alice@example.com', 'cal-A', 'gcal:A')
    seedAccountAndCalendar(db, 'bob@example.com', 'cal-B', 'gcal:B')
    const binding: typeof calendarBindings.$inferSelect = {
      id: 'binding-1',
      sourceType: 'event',
      sourceId: 'evt-1',
      provider: 'google',
      remoteCalendarId: 'cal-B',
      remoteEventId: 'remote-evt-1',
      ownershipMode: 'memry_managed',
      writebackMode: 'broad',
      remoteVersion: null,
      lastLocalSnapshot: null,
      archivedAt: null,
      clock: null,
      syncedAt: null,
      createdAt: NOW,
      modifiedAt: NOW
    }

    // #when
    const accountId = resolveTargetGoogleAccountId(
      db,
      { sourceType: 'event', sourceId: 'evt-1' },
      binding
    )

    // #then
    expect(accountId).toBe('bob@example.com')
  })

  it('routes through event.targetCalendarId when no existing binding', () => {
    seedAccountAndCalendar(db, 'alice@example.com', 'cal-A', 'gcal:A')
    seedAccountAndCalendar(db, 'bob@example.com', 'cal-B', 'gcal:B')
    db.insert(calendarEvents)
      .values({
        id: 'evt-2',
        title: 'Routed event',
        startAt: NOW,
        endAt: null,
        timezone: 'UTC',
        isAllDay: false,
        targetCalendarId: 'cal-A',
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()

    const accountId = resolveTargetGoogleAccountId(
      db,
      { sourceType: 'event', sourceId: 'evt-2' },
      undefined
    )

    expect(accountId).toBe('alice@example.com')
  })

  it('falls back to default Google account when no calendar context resolves', () => {
    seedAccountAndCalendar(db, 'alice@example.com', 'cal-A', 'gcal:A')

    const accountId = resolveTargetGoogleAccountId(
      db,
      { sourceType: 'task', sourceId: 'task-1' },
      undefined
    )

    expect(accountId).toBe('fallback-default@example.com')
  })

  it('returns null when neither calendar context nor any default account exists', async () => {
    const oauth = await import('./oauth')
    vi.mocked(oauth.resolveDefaultGoogleAccountId).mockReturnValueOnce(null)

    const accountId = resolveTargetGoogleAccountId(
      db,
      { sourceType: 'task', sourceId: 'task-1' },
      undefined
    )

    expect(accountId).toBeNull()
  })
})
