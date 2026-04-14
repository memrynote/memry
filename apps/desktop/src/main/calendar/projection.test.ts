import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  createTestDataDb,
  seedInboxItem,
  seedTestData,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import { getCalendarRangeProjection } from './projection'

describe('getCalendarRangeProjection', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb
  let projectId: string
  let todoStatusId: string

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db

    const seeded = seedTestData(db)
    projectId = seeded.projectId
    todoStatusId = seeded.statusIds.todo
  })

  afterEach(() => {
    dbResult.close()
  })

  function getLocalDayRange(date: { year: number; monthIndex: number; day: number }): {
    startAt: string
    endAt: string
  } {
    return {
      startAt: new Date(date.year, date.monthIndex, date.day, 0, 0, 0, 0).toISOString(),
      endAt: new Date(date.year, date.monthIndex, date.day + 1, 0, 0, 0, 0).toISOString()
    }
  }

  it('returns Memry events, task due items, reminders, snoozes, and selected external events in one range query', () => {
    const range = getLocalDayRange({ year: 2026, monthIndex: 3, day: 14 })

    db.run(sql`
      INSERT INTO calendar_events (
        id,
        title,
        description,
        start_at,
        end_at,
        timezone,
        is_all_day,
        clock,
        created_at,
        modified_at
      )
      VALUES (
        ${'event-1'},
        ${'Team Sync'},
        ${'Planning notes'},
        ${'2026-04-14T09:00:00.000Z'},
        ${'2026-04-14T10:00:00.000Z'},
        ${'UTC'},
        ${0},
        ${JSON.stringify({ 'device-a': 1 })},
        ${'2026-04-12T08:00:00.000Z'},
        ${'2026-04-12T08:00:00.000Z'}
      )
    `)

    db.run(sql`
      INSERT INTO calendar_bindings (
        id,
        source_type,
        source_id,
        provider,
        remote_calendar_id,
        remote_event_id,
        ownership_mode,
        writeback_mode,
        clock,
        created_at,
        modified_at
      )
      VALUES (
        ${'binding-event-1'},
        ${'event'},
        ${'event-1'},
        ${'google'},
        ${'memry-calendar'},
        ${'google-event-1'},
        ${'memry_managed'},
        ${'broad'},
        ${JSON.stringify({ 'device-a': 1 })},
        ${'2026-04-12T08:05:00.000Z'},
        ${'2026-04-12T08:05:00.000Z'}
      )
    `)

    db.run(sql`
      INSERT INTO tasks (
        id,
        project_id,
        status_id,
        title,
        description,
        position,
        due_date,
        due_time,
        created_at,
        modified_at
      )
      VALUES (
        ${'task-all-day'},
        ${projectId},
        ${todoStatusId},
        ${'Draft brief'},
        ${'Due today'},
        ${3},
        ${'2026-04-14'},
        ${null},
        ${'2026-04-12T08:10:00.000Z'},
        ${'2026-04-12T08:10:00.000Z'}
      )
    `)

    db.run(sql`
      INSERT INTO tasks (
        id,
        project_id,
        status_id,
        title,
        description,
        position,
        due_date,
        due_time,
        created_at,
        modified_at
      )
      VALUES (
        ${'task-timed'},
        ${projectId},
        ${todoStatusId},
        ${'Ship release'},
        ${'Time-boxed due task'},
        ${4},
        ${'2026-04-14'},
        ${'15:30'},
        ${'2026-04-12T08:15:00.000Z'},
        ${'2026-04-12T08:15:00.000Z'}
      )
    `)

    db.run(sql`
      INSERT INTO reminders (
        id,
        target_type,
        target_id,
        remind_at,
        title,
        note,
        status,
        created_at,
        modified_at
      )
      VALUES (
        ${'rem-1'},
        ${'note'},
        ${'note-1'},
        ${'2026-04-14T11:00:00.000Z'},
        ${'Check contract'},
        ${'Need final review'},
        ${'pending'},
        ${'2026-04-12T08:20:00.000Z'},
        ${'2026-04-12T08:20:00.000Z'}
      )
    `)

    seedInboxItem(db, {
      id: 'inbox-1',
      type: 'note',
      title: 'Resurface this later',
      content: 'Follow up after lunch',
      snoozedUntil: '2026-04-14T12:00:00.000Z',
      snoozeReason: 'Later today',
      createdAt: '2026-04-12T08:25:00.000Z'
    })

    db.run(sql`
      INSERT INTO calendar_sources (
        id,
        provider,
        kind,
        account_id,
        remote_id,
        title,
        timezone,
        color,
        is_selected,
        is_memry_managed,
        sync_status,
        clock,
        created_at,
        modified_at
      )
      VALUES (
        ${'source-selected'},
        ${'google'},
        ${'calendar'},
        ${'google-account-1'},
        ${'remote-selected'},
        ${'Work'},
        ${'UTC'},
        ${'#0f9d58'},
        ${1},
        ${0},
        ${'ok'},
        ${JSON.stringify({ 'device-a': 1 })},
        ${'2026-04-12T08:30:00.000Z'},
        ${'2026-04-12T08:30:00.000Z'}
      )
    `)

    db.run(sql`
      INSERT INTO calendar_sources (
        id,
        provider,
        kind,
        account_id,
        remote_id,
        title,
        timezone,
        color,
        is_selected,
        is_memry_managed,
        sync_status,
        clock,
        created_at,
        modified_at
      )
      VALUES (
        ${'source-hidden'},
        ${'google'},
        ${'calendar'},
        ${'google-account-1'},
        ${'remote-hidden'},
        ${'Hidden'},
        ${'UTC'},
        ${'#9aa0a6'},
        ${0},
        ${0},
        ${'ok'},
        ${JSON.stringify({ 'device-a': 1 })},
        ${'2026-04-12T08:35:00.000Z'},
        ${'2026-04-12T08:35:00.000Z'}
      )
    `)

    db.run(sql`
      INSERT INTO calendar_external_events (
        id,
        source_id,
        remote_event_id,
        remote_etag,
        remote_updated_at,
        title,
        description,
        start_at,
        end_at,
        timezone,
        is_all_day,
        status,
        raw_payload,
        clock,
        created_at,
        modified_at
      )
      VALUES (
        ${'external-1'},
        ${'source-selected'},
        ${'google-external-1'},
        ${'etag-1'},
        ${'2026-04-12T08:40:00.000Z'},
        ${'Imported review'},
        ${'From Google'},
        ${'2026-04-14T13:00:00.000Z'},
        ${'2026-04-14T14:00:00.000Z'},
        ${'UTC'},
        ${0},
        ${'confirmed'},
        ${JSON.stringify({ summary: 'Imported review' })},
        ${JSON.stringify({ 'device-a': 1 })},
        ${'2026-04-12T08:40:00.000Z'},
        ${'2026-04-12T08:40:00.000Z'}
      )
    `)

    db.run(sql`
      INSERT INTO calendar_external_events (
        id,
        source_id,
        remote_event_id,
        remote_etag,
        remote_updated_at,
        title,
        description,
        start_at,
        end_at,
        timezone,
        is_all_day,
        status,
        raw_payload,
        clock,
        created_at,
        modified_at
      )
      VALUES (
        ${'external-hidden'},
        ${'source-hidden'},
        ${'google-external-hidden'},
        ${'etag-hidden'},
        ${'2026-04-12T08:45:00.000Z'},
        ${'Hidden imported event'},
        ${'Unselected source'},
        ${'2026-04-14T16:00:00.000Z'},
        ${'2026-04-14T17:00:00.000Z'},
        ${'UTC'},
        ${0},
        ${'confirmed'},
        ${JSON.stringify({ summary: 'Hidden imported event' })},
        ${JSON.stringify({ 'device-a': 1 })},
        ${'2026-04-12T08:45:00.000Z'},
        ${'2026-04-12T08:45:00.000Z'}
      )
    `)

    const result = getCalendarRangeProjection(db, {
      startAt: range.startAt,
      endAt: range.endAt,
      includeUnselectedSources: false
    })

    expect(result.items).toHaveLength(6)
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectionId: 'event:event-1',
          sourceType: 'event',
          sourceId: 'event-1',
          title: 'Team Sync',
          visualType: 'event',
          binding: expect.objectContaining({
            provider: 'google',
            remoteCalendarId: 'memry-calendar',
            remoteEventId: 'google-event-1'
          })
        }),
        expect.objectContaining({
          projectionId: 'task:task-all-day',
          sourceType: 'task',
          sourceId: 'task-all-day',
          title: 'Draft brief',
          isAllDay: true,
          visualType: 'task',
          binding: null
        }),
        expect.objectContaining({
          projectionId: 'task:task-timed',
          sourceType: 'task',
          sourceId: 'task-timed',
          title: 'Ship release',
          isAllDay: false,
          visualType: 'task',
          binding: null
        }),
        expect.objectContaining({
          projectionId: 'reminder:rem-1',
          sourceType: 'reminder',
          sourceId: 'rem-1',
          title: 'Check contract',
          visualType: 'reminder'
        }),
        expect.objectContaining({
          projectionId: 'inbox_snooze:inbox-1',
          sourceType: 'inbox_snooze',
          sourceId: 'inbox-1',
          title: 'Resurface this later',
          visualType: 'snooze'
        }),
        expect.objectContaining({
          projectionId: 'external_event:external-1',
          sourceType: 'external_event',
          sourceId: 'external-1',
          title: 'Imported review',
          visualType: 'external_event',
          source: expect.objectContaining({
            provider: 'google',
            calendarSourceId: 'source-selected',
            title: 'Work'
          })
        })
      ])
    )
    expect(result.items.some((item) => item.sourceId === 'external-hidden')).toBe(false)
  })

  it('includes unselected external sources when requested', () => {
    const range = getLocalDayRange({ year: 2026, monthIndex: 3, day: 14 })

    db.run(sql`
      INSERT INTO calendar_sources (
        id,
        provider,
        kind,
        account_id,
        remote_id,
        title,
        timezone,
        is_selected,
        is_memry_managed,
        sync_status,
        clock,
        created_at,
        modified_at
      )
      VALUES (
        ${'source-hidden'},
        ${'google'},
        ${'calendar'},
        ${'google-account-1'},
        ${'remote-hidden'},
        ${'Hidden'},
        ${'UTC'},
        ${0},
        ${0},
        ${'ok'},
        ${JSON.stringify({ 'device-a': 1 })},
        ${'2026-04-12T08:35:00.000Z'},
        ${'2026-04-12T08:35:00.000Z'}
      )
    `)

    db.run(sql`
      INSERT INTO calendar_external_events (
        id,
        source_id,
        remote_event_id,
        remote_etag,
        remote_updated_at,
        title,
        start_at,
        end_at,
        timezone,
        is_all_day,
        status,
        raw_payload,
        clock,
        created_at,
        modified_at
      )
      VALUES (
        ${'external-hidden'},
        ${'source-hidden'},
        ${'google-external-hidden'},
        ${'etag-hidden'},
        ${'2026-04-12T08:45:00.000Z'},
        ${'Hidden imported event'},
        ${'2026-04-14T16:00:00.000Z'},
        ${'2026-04-14T17:00:00.000Z'},
        ${'UTC'},
        ${0},
        ${'confirmed'},
        ${JSON.stringify({ summary: 'Hidden imported event' })},
        ${JSON.stringify({ 'device-a': 1 })},
        ${'2026-04-12T08:45:00.000Z'},
        ${'2026-04-12T08:45:00.000Z'}
      )
    `)

    const result = getCalendarRangeProjection(db, {
      startAt: range.startAt,
      endAt: range.endAt,
      includeUnselectedSources: true
    })

    expect(result.items).toEqual([
      expect.objectContaining({
        projectionId: 'external_event:external-hidden',
        sourceType: 'external_event',
        sourceId: 'external-hidden',
        title: 'Hidden imported event'
      })
    ])
  })
})
