import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  createTestDataDb,
  createTestIndexDb,
  seedInboxItem,
  seedTestData,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import type { DataDb, IndexDb } from '../../main/database'
import { getCalendarRangeProjection } from './projection'

describe('getCalendarRangeProjection', () => {
  let dbResult: TestDatabaseResult
  let indexDbResult: TestDatabaseResult
  let db: TestDb
  let indexDb: IndexDb
  let projectId: string
  let todoStatusId: string

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db

    indexDbResult = createTestIndexDb()
    indexDb = indexDbResult.db as unknown as IndexDb

    const seeded = seedTestData(db)
    projectId = seeded.projectId
    todoStatusId = seeded.statusIds.todo
  })

  afterEach(() => {
    dbResult.close()
    indexDbResult.close()
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

  it('returns memrynote events, task due items, reminders, snoozes, and selected external events in one range query', () => {
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

    const result = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      {
        startAt: range.startAt,
        endAt: range.endAt,
        includeUnselectedSources: false
      },
      []
    )

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

    const result = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      {
        startAt: range.startAt,
        endAt: range.endAt,
        includeUnselectedSources: true
      },
      []
    )

    expect(result.items).toEqual([
      expect.objectContaining({
        projectionId: 'external_event:external-hidden',
        sourceType: 'external_event',
        sourceId: 'external-hidden',
        title: 'Hidden imported event'
      })
    ])
  })

  it('excludes external events when includeExternal is false', () => {
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
        ${'event-native'},
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

    const result = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      {
        startAt: range.startAt,
        endAt: range.endAt,
        includeUnselectedSources: false,
        includeExternal: false
      },
      []
    )

    expect(result.items.some((item) => item.sourceType === 'external_event')).toBe(false)
    expect(result.items.some((item) => item.sourceId === 'event-native')).toBe(true)
  })

  it('projects notes with an enabled date property', () => {
    indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${'n1'}, ${'notes/q3-launch.md'}, ${'Q3 Launch'}, ${'markdown'}, ${'2026-06-01T00:00:00.000Z'}, ${'2026-06-01T00:00:00.000Z'})
    `)
    indexDbResult.db.run(sql`
      INSERT INTO note_properties (note_id, name, type, value)
      VALUES (${'n1'}, ${'Deadline'}, ${'date'}, ${'2026-06-20T00:00:00.000Z'})
    `)

    const { items } = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      {
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: '2026-07-01T00:00:00.000Z',
        includeUnselectedSources: false
      },
      ['Deadline']
    )

    const note = items.find((i) => i.sourceType === 'note')
    expect(note).toBeDefined()
    expect(note!.title).toBe('Q3 Launch')
    expect(note!.visualType).toBe('note')
    expect(note!.isAllDay).toBe(true)
    expect(note!.projectionId).toBe('note:n1:Deadline')
    expect(note!.descriptionPreview).toBe('Deadline')
    expect(note!.editability).toEqual({
      canMove: false,
      canResize: false,
      canEditText: false,
      canDelete: false
    })
  })

  it('omits the note when its property is not in enabledNames', () => {
    indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${'n1'}, ${'notes/q3-launch.md'}, ${'Q3 Launch'}, ${'markdown'}, ${'2026-06-01T00:00:00.000Z'}, ${'2026-06-01T00:00:00.000Z'})
    `)
    indexDbResult.db.run(sql`
      INSERT INTO note_properties (note_id, name, type, value)
      VALUES (${'n1'}, ${'Deadline'}, ${'date'}, ${'2026-06-20T00:00:00.000Z'})
    `)

    const { items } = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      {
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: '2026-07-01T00:00:00.000Z',
        includeUnselectedSources: false
      },
      []
    )

    expect(items.some((i) => i.sourceType === 'note')).toBe(false)
  })

  it('plots regular notes by their created date when showNotesByCreated is on', () => {
    indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${'n-created'}, ${'notes/idea.md'}, ${'Idea'}, ${'markdown'}, ${'2026-06-15T09:00:00.000Z'}, ${'2026-06-15T09:00:00.000Z'})
    `)
    // Journal entry (date set) must NOT be double-plotted by its created date.
    indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, date, created_at, modified_at)
      VALUES (${'j1'}, ${'journal/2026-06-16.md'}, ${'2026-06-16'}, ${'markdown'}, ${'2026-06-16'}, ${'2026-06-16T09:00:00.000Z'}, ${'2026-06-16T09:00:00.000Z'})
    `)

    const { items } = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      {
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: '2026-07-01T00:00:00.000Z',
        includeUnselectedSources: false
      },
      [],
      true
    )

    const note = items.find((i) => i.projectionId === 'note-created:n-created')
    expect(note).toBeDefined()
    expect(note!.sourceType).toBe('note')
    expect(note!.title).toBe('Idea')
    expect(note!.isAllDay).toBe(true)
    expect(items.some((i) => i.projectionId === 'note-created:j1')).toBe(false)
  })

  it('keeps only the property chip when a calendar-enabled date property lands on the creation day', () => {
    indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${'n-both'}, ${'notes/plan.md'}, ${'Plan'}, ${'markdown'}, ${'2026-06-15T09:00:00.000Z'}, ${'2026-06-15T09:00:00.000Z'})
    `)
    indexDbResult.db.run(sql`
      INSERT INTO note_properties (note_id, name, type, value)
      VALUES (${'n-both'}, ${'Deadline'}, ${'date'}, ${'2026-06-15T09:00:00.000Z'})
    `)

    const { items } = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      {
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: '2026-07-01T00:00:00.000Z',
        includeUnselectedSources: false
      },
      ['Deadline'],
      true
    )

    const noteItems = items.filter((i) => i.sourceType === 'note')
    expect(noteItems.map((i) => i.projectionId)).toEqual(['note:n-both:Deadline'])
  })

  it('keeps both chips when the date property falls on a different day than creation', () => {
    indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${'n-later'}, ${'notes/launch.md'}, ${'Launch'}, ${'markdown'}, ${'2026-06-15T09:00:00.000Z'}, ${'2026-06-15T09:00:00.000Z'})
    `)
    indexDbResult.db.run(sql`
      INSERT INTO note_properties (note_id, name, type, value)
      VALUES (${'n-later'}, ${'Deadline'}, ${'date'}, ${'2026-06-20T09:00:00.000Z'})
    `)

    const { items } = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      {
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: '2026-07-01T00:00:00.000Z',
        includeUnselectedSources: false
      },
      ['Deadline'],
      true
    )

    const ids = items.filter((i) => i.sourceType === 'note').map((i) => i.projectionId)
    expect(ids).toContain('note:n-later:Deadline')
    expect(ids).toContain('note-created:n-later')
  })

  it('omits created-date notes when showNotesByCreated is off', () => {
    indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${'n-created'}, ${'notes/idea.md'}, ${'Idea'}, ${'markdown'}, ${'2026-06-15T09:00:00.000Z'}, ${'2026-06-15T09:00:00.000Z'})
    `)

    const { items } = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      {
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: '2026-07-01T00:00:00.000Z',
        includeUnselectedSources: false
      },
      []
    )

    expect(items.some((i) => i.projectionId.startsWith('note-created:'))).toBe(false)
  })

  it('excludes a note date property that falls outside the query window', () => {
    indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${'n-out'}, ${'notes/old.md'}, ${'Old Note'}, ${'markdown'}, ${'2026-05-01T00:00:00.000Z'}, ${'2026-05-01T00:00:00.000Z'})
    `)
    indexDbResult.db.run(sql`
      INSERT INTO note_properties (note_id, name, type, value)
      VALUES (${'n-out'}, ${'Deadline'}, ${'date'}, ${'2026-05-10T00:00:00.000Z'})
    `)

    const { items } = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      {
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: '2026-07-01T00:00:00.000Z',
        includeUnselectedSources: false
      },
      ['Deadline']
    )

    expect(items.some((i) => i.sourceType === 'note')).toBe(false)
  })

  it('projects two enabled date properties on one note as two chips', () => {
    indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${'n2'}, ${'notes/article.md'}, ${'Article'}, ${'markdown'}, ${'2026-06-01T00:00:00.000Z'}, ${'2026-06-01T00:00:00.000Z'})
    `)
    indexDbResult.db.run(sql`
      INSERT INTO note_properties (note_id, name, type, value)
      VALUES (${'n2'}, ${'Deadline'}, ${'date'}, ${'2026-06-10T00:00:00.000Z'})
    `)
    indexDbResult.db.run(sql`
      INSERT INTO note_properties (note_id, name, type, value)
      VALUES (${'n2'}, ${'Published'}, ${'date'}, ${'2026-06-20T00:00:00.000Z'})
    `)

    const { items } = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      {
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: '2026-07-01T00:00:00.000Z',
        includeUnselectedSources: false
      },
      ['Deadline', 'Published']
    )

    const noteItems = items.filter((i) => i.sourceType === 'note')
    expect(noteItems).toHaveLength(2)
    const ids = noteItems.map((i) => i.projectionId).sort()
    expect(ids).toEqual(['note:n2:Deadline', 'note:n2:Published'])
  })

  it('places a bare YYYY-MM-DD property on the correct calendar day without timezone shift', () => {
    indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${'n3'}, ${'notes/bare-date.md'}, ${'Bare Date Note'}, ${'markdown'}, ${'2026-06-01T00:00:00.000Z'}, ${'2026-06-01T00:00:00.000Z'})
    `)
    // Bare YYYY-MM-DD — no time component
    indexDbResult.db.run(sql`
      INSERT INTO note_properties (note_id, name, type, value)
      VALUES (${'n3'}, ${'Deadline'}, ${'date'}, ${'2026-06-15'})
    `)

    const { items } = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      {
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: '2026-07-01T00:00:00.000Z',
        includeUnselectedSources: false
      },
      ['Deadline']
    )

    const note = items.find((i) => i.sourceType === 'note')
    expect(note).toBeDefined()
    expect(note!.projectionId).toBe('note:n3:Deadline')

    // Verify the projected startAt lands on June 15 in local time (not shifted by UTC parse)
    const d = new Date(note!.startAt)
    const localDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(localDay).toBe('2026-06-15')
  })

  it('projects a note_date reminder as a read-only note_date item with the note title', () => {
    const range = getLocalDayRange({ year: 2026, monthIndex: 3, day: 14 })

    indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${'note-7'}, ${'notes/launch.md'}, ${'Launch Plan'}, ${'markdown'}, ${'2026-04-12T08:00:00.000Z'}, ${'2026-04-12T08:00:00.000Z'})
    `)
    db.run(sql`
      INSERT INTO reminders (
        id, target_type, target_id, remind_at, anchor_id, status, created_at, modified_at
      )
      VALUES (
        ${'rem-nd-1'}, ${'note_date'}, ${'note-7'}, ${'2026-04-14T11:00:00.000Z'}, ${'anchor-1'}, ${'pending'}, ${'2026-04-12T08:20:00.000Z'}, ${'2026-04-12T08:20:00.000Z'}
      )
    `)

    const { items } = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      { ...range, includeUnselectedSources: false },
      []
    )

    const item = items.find((i) => i.sourceType === 'note_date')
    expect(item).toBeDefined()
    expect(item!.visualType).toBe('note_date')
    expect(item!.title).toBe('Launch Plan')
    expect(item!.startAt).toBe('2026-04-14T11:00:00.000Z')
    expect(item!.isAllDay).toBe(false)
    expect(item!.projectionId).toBe('note_date:rem-nd-1')
    expect(item!.noteId).toBe('note-7')
    expect(item!.anchorId).toBe('anchor-1')
    expect(item!.isTriggered).toBe(false)
    expect(item!.editability).toEqual({
      canMove: false,
      canResize: false,
      canEditText: false,
      canDelete: false
    })
    // Must NOT leak in as a generic editable reminder chip.
    expect(items.some((i) => i.visualType === 'reminder')).toBe(false)
  })

  it('positions a snoozed note_date reminder at its snoozedUntil', () => {
    const range = getLocalDayRange({ year: 2026, monthIndex: 3, day: 14 })

    indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${'note-8'}, ${'notes/review.md'}, ${'Review'}, ${'markdown'}, ${'2026-04-12T08:00:00.000Z'}, ${'2026-04-12T08:00:00.000Z'})
    `)
    db.run(sql`
      INSERT INTO reminders (
        id, target_type, target_id, remind_at, anchor_id, status, snoozed_until, created_at, modified_at
      )
      VALUES (
        ${'rem-nd-2'}, ${'note_date'}, ${'note-8'}, ${'2026-04-13T09:00:00.000Z'}, ${'anchor-2'}, ${'snoozed'}, ${'2026-04-14T12:00:00.000Z'}, ${'2026-04-12T08:20:00.000Z'}, ${'2026-04-12T08:20:00.000Z'}
      )
    `)

    const { items } = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      { ...range, includeUnselectedSources: false },
      []
    )

    const item = items.find((i) => i.sourceType === 'note_date')
    expect(item).toBeDefined()
    expect(item!.startAt).toBe('2026-04-14T12:00:00.000Z')
    expect(item!.snoozeOffsetMinutes).toBe(
      Math.round(
        (new Date('2026-04-14T12:00:00.000Z').getTime() -
          new Date('2026-04-13T09:00:00.000Z').getTime()) /
          60000
      )
    )
  })

  it('keeps a triggered note_date reminder on the calendar, flagged as fired', () => {
    const range = getLocalDayRange({ year: 2026, monthIndex: 3, day: 14 })

    indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${'note-9'}, ${'notes/standup.md'}, ${'Standup'}, ${'markdown'}, ${'2026-04-12T08:00:00.000Z'}, ${'2026-04-12T08:00:00.000Z'})
    `)
    db.run(sql`
      INSERT INTO reminders (
        id, target_type, target_id, remind_at, anchor_id, status, triggered_at, created_at, modified_at
      )
      VALUES (
        ${'rem-nd-3'}, ${'note_date'}, ${'note-9'}, ${'2026-04-14T11:00:00.000Z'}, ${'anchor-3'}, ${'triggered'}, ${'2026-04-14T11:00:01.000Z'}, ${'2026-04-12T08:20:00.000Z'}, ${'2026-04-12T08:20:00.000Z'}
      )
    `)

    const { items } = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDb,
      { ...range, includeUnselectedSources: false },
      []
    )

    const item = items.find((i) => i.sourceType === 'note_date')
    expect(item).toBeDefined()
    expect(item!.title).toBe('Standup')
    expect(item!.startAt).toBe('2026-04-14T11:00:00.000Z')
    expect(item!.isTriggered).toBe(true)
  })
})
