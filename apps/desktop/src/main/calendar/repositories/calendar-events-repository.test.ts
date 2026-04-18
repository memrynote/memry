import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult, type TestDb } from '@tests/utils/test-db'
import { upsertCalendarEvent, getCalendarEventById } from './calendar-events-repository'
import type { DataDb } from '../../database/types'

describe('calendarEvents.targetCalendarId (M2)', () => {
  let dbResult: TestDatabaseResult
  let dataDb: DataDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    dataDb = dbResult.db as unknown as DataDb
  })

  afterEach(() => {
    dbResult.close()
  })

  it('round-trips targetCalendarId through upsertCalendarEvent + getCalendarEventById', () => {
    // #given — a new event pointed at a specific Google calendar
    const baseEvent = {
      id: 'event-target-1',
      title: 'Team sync',
      startAt: '2026-04-20T09:00:00.000Z',
      endAt: '2026-04-20T10:00:00.000Z',
      timezone: 'UTC',
      isAllDay: false,
      targetCalendarId: 'work@group.calendar.google.com',
      clock: { 'device-a': 1 },
      createdAt: '2026-04-18T12:00:00.000Z',
      modifiedAt: '2026-04-18T12:00:00.000Z'
    }

    // #when — we persist it and read it back through the repository layer
    upsertCalendarEvent(dataDb, baseEvent)
    const stored = getCalendarEventById(dataDb, 'event-target-1')

    // #then — the targetCalendarId survives the round-trip
    expect(stored?.targetCalendarId).toBe('work@group.calendar.google.com')
  })

  it('defaults targetCalendarId to null when not provided', () => {
    // #given — an event inserted without targetCalendarId (M1-era payload)
    upsertCalendarEvent(dataDb, {
      id: 'event-target-null',
      title: 'Legacy event',
      startAt: '2026-04-20T09:00:00.000Z',
      timezone: 'UTC',
      isAllDay: false,
      clock: { 'device-a': 1 },
      createdAt: '2026-04-18T12:00:00.000Z',
      modifiedAt: '2026-04-18T12:00:00.000Z'
    })

    // #when — we read it back
    const stored = getCalendarEventById(dataDb, 'event-target-null')

    // #then — targetCalendarId is nullable and defaults to null
    expect(stored?.targetCalendarId).toBeNull()
  })

  it('updates targetCalendarId when upsertCalendarEvent re-targets an existing row', () => {
    // #given — event initially targets the Memry-managed calendar
    upsertCalendarEvent(dataDb, {
      id: 'event-retarget',
      title: 'Retargetable event',
      startAt: '2026-04-20T09:00:00.000Z',
      timezone: 'UTC',
      isAllDay: false,
      targetCalendarId: 'memry-managed@group.calendar.google.com',
      clock: { 'device-a': 1 },
      createdAt: '2026-04-18T12:00:00.000Z',
      modifiedAt: '2026-04-18T12:00:00.000Z'
    })

    // #when — user picks a different calendar via the picker
    upsertCalendarEvent(dataDb, {
      id: 'event-retarget',
      title: 'Retargetable event',
      startAt: '2026-04-20T09:00:00.000Z',
      timezone: 'UTC',
      isAllDay: false,
      targetCalendarId: 'personal@group.calendar.google.com',
      clock: { 'device-a': 2 },
      createdAt: '2026-04-18T12:00:00.000Z',
      modifiedAt: '2026-04-18T12:05:00.000Z'
    })

    // #then — the stored row reflects the new target
    const stored = getCalendarEventById(dataDb, 'event-retarget')
    expect(stored?.targetCalendarId).toBe('personal@group.calendar.google.com')
  })
})

describe('calendar storage foundation', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  it('stores, updates, and archives clocked Memry calendar events', () => {
    expect(() =>
      db.run(sql`
        INSERT INTO calendar_events (
          id,
          title,
          description,
          location,
          start_at,
          end_at,
          timezone,
          is_all_day,
          recurrence_rule,
          recurrence_exceptions,
          clock,
          created_at,
          modified_at
        )
        VALUES (
          ${'event-1'},
          ${'Quarterly Planning'},
          ${'Align roadmap'},
          ${'Studio'},
          ${'2026-04-12T09:00:00.000Z'},
          ${'2026-04-12T10:00:00.000Z'},
          ${'UTC'},
          ${0},
          ${JSON.stringify({ freq: 'WEEKLY', interval: 1 })},
          ${JSON.stringify([])},
          ${JSON.stringify({ 'device-a': 1 })},
          ${'2026-04-12T08:30:00.000Z'},
          ${'2026-04-12T08:30:00.000Z'}
        )
      `)
    ).not.toThrow()

    db.run(sql`
      UPDATE calendar_events
      SET title = ${'Quarterly Planning Review'},
          archived_at = ${'2026-04-12T11:00:00.000Z'},
          modified_at = ${'2026-04-12T11:00:00.000Z'}
      WHERE id = ${'event-1'}
    `)

    const stored = dbResult.sqlite
      .prepare(
        `
          SELECT id, title, timezone, is_all_day, clock, archived_at
          FROM calendar_events
          WHERE id = ?
        `
      )
      .get('event-1') as
      | {
          id: string
          title: string
          timezone: string
          is_all_day: number
          clock: string
          archived_at: string | null
        }
      | undefined

    expect(stored).toMatchObject({
      id: 'event-1',
      title: 'Quarterly Planning Review',
      timezone: 'UTC',
      is_all_day: 0,
      archived_at: '2026-04-12T11:00:00.000Z'
    })
    expect(JSON.parse(stored?.clock ?? '{}')).toEqual({ 'device-a': 1 })
  })

  it('stores shareable provider metadata and imported external event cache without OAuth tokens', () => {
    expect(() =>
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
          sync_cursor,
          sync_status,
          clock,
          created_at,
          modified_at
        )
        VALUES (
          ${'google-account-1'},
          ${'google'},
          ${'account'},
          ${null},
          ${'acct-remote-1'},
          ${'h4yfans@gmail.com'},
          ${'Europe/Istanbul'},
          ${0},
          ${0},
          ${'cursor-account-1'},
          ${'idle'},
          ${JSON.stringify({ 'device-a': 2 })},
          ${'2026-04-12T08:00:00.000Z'},
          ${'2026-04-12T08:00:00.000Z'}
        )
      `)
    ).not.toThrow()

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
        sync_cursor,
        sync_status,
        clock,
        created_at,
        modified_at
      )
      VALUES (
        ${'google-calendar-1'},
        ${'google'},
        ${'calendar'},
        ${'google-account-1'},
        ${'calendar-remote-1'},
        ${'Work'},
        ${'Europe/Istanbul'},
        ${1},
        ${0},
        ${'cursor-calendar-1'},
        ${'ok'},
        ${JSON.stringify({ 'device-a': 3 })},
        ${'2026-04-12T08:05:00.000Z'},
        ${'2026-04-12T08:05:00.000Z'}
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
        location,
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
        ${'external-event-1'},
        ${'google-calendar-1'},
        ${'google-remote-event-1'},
        ${'etag-1'},
        ${'2026-04-12T08:10:00.000Z'},
        ${'Imported Event'},
        ${'Imported from Google'},
        ${'Office'},
        ${'2026-04-13T10:00:00.000Z'},
        ${'2026-04-13T11:00:00.000Z'},
        ${'Europe/Istanbul'},
        ${0},
        ${'confirmed'},
        ${JSON.stringify({ summary: 'Imported Event' })},
        ${JSON.stringify({ 'device-a': 4 })},
        ${'2026-04-12T08:10:00.000Z'},
        ${'2026-04-12T08:10:00.000Z'}
      )
    `)

    const sourceColumns = dbResult.sqlite
      .prepare('PRAGMA table_info(calendar_sources)')
      .all() as Array<{ name: string }>

    expect(sourceColumns.map((column) => column.name)).not.toContain('access_token')
    expect(sourceColumns.map((column) => column.name)).not.toContain('refresh_token')

    const selectedCalendars = dbResult.sqlite
      .prepare(
        `
          SELECT id, kind, account_id, title, is_selected, is_memry_managed
          FROM calendar_sources
          WHERE kind = 'calendar'
        `
      )
      .all() as Array<{
      id: string
      kind: string
      account_id: string
      title: string
      is_selected: number
      is_memry_managed: number
    }>

    expect(selectedCalendars).toEqual([
      {
        id: 'google-calendar-1',
        kind: 'calendar',
        account_id: 'google-account-1',
        title: 'Work',
        is_selected: 1,
        is_memry_managed: 0
      }
    ])

    const externalEvent = dbResult.sqlite
      .prepare(
        `
          SELECT source_id, remote_event_id, remote_etag, title
          FROM calendar_external_events
          WHERE id = ?
        `
      )
      .get('external-event-1') as
      | { source_id: string; remote_event_id: string; remote_etag: string; title: string }
      | undefined

    expect(externalEvent).toMatchObject({
      source_id: 'google-calendar-1',
      remote_event_id: 'google-remote-event-1',
      remote_etag: 'etag-1',
      title: 'Imported Event'
    })
  })

  it('stores sync bindings for Memry events, tasks, reminders, and inbox snoozes', () => {
    const bindingRows = [
      ['binding-event-1', 'event', 'event-1', 'google', 'memry-calendar', 'remote-event-1'],
      ['binding-task-1', 'task', 'task-1', 'google', 'memry-calendar', 'remote-task-1'],
      [
        'binding-reminder-1',
        'reminder',
        'reminder-1',
        'google',
        'memry-calendar',
        'remote-reminder-1'
      ],
      [
        'binding-snooze-1',
        'inbox_snooze',
        'inbox-item-1',
        'google',
        'memry-calendar',
        'remote-snooze-1'
      ]
    ] as const

    for (const [
      id,
      sourceType,
      sourceId,
      provider,
      remoteCalendarId,
      remoteEventId
    ] of bindingRows) {
      expect(() =>
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
            remote_version,
            last_local_snapshot,
            clock,
            created_at,
            modified_at
          )
          VALUES (
            ${id},
            ${sourceType},
            ${sourceId},
            ${provider},
            ${remoteCalendarId},
            ${remoteEventId},
            ${'memry_managed'},
            ${'broad'},
            ${'etag-1'},
            ${JSON.stringify({ title: sourceId })},
            ${JSON.stringify({ 'device-a': 5 })},
            ${'2026-04-12T08:15:00.000Z'},
            ${'2026-04-12T08:15:00.000Z'}
          )
        `)
      ).not.toThrow()
    }

    const sourceTypes = dbResult.sqlite
      .prepare(
        `
          SELECT source_type
          FROM calendar_bindings
          ORDER BY source_type ASC
        `
      )
      .all() as Array<{ source_type: string }>

    expect(sourceTypes.map((row) => row.source_type)).toEqual([
      'event',
      'inbox_snooze',
      'reminder',
      'task'
    ])
  })
})
