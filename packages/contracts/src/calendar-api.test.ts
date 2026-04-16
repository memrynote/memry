/**
 * Calendar API Contract Tests
 */

import { describe, it, expect } from 'vitest'
import {
  CalendarSourceKindSchema,
  CalendarSourceSyncStatusSchema,
  CalendarProjectionSourceTypeSchema,
  CalendarProjectionVisualTypeSchema,
  CalendarChangeEntityTypeSchema,
  CreateCalendarEventSchema,
  UpdateCalendarEventSchema,
  ListCalendarEventsSchema,
  GetCalendarRangeSchema,
  ListCalendarSourcesSchema,
  UpdateCalendarSourceSelectionSchema,
  CalendarProviderRequestSchema
} from './calendar-api'

describe('CalendarSourceKindSchema', () => {
  it('accepts valid kinds', () => {
    expect(CalendarSourceKindSchema.safeParse('account').success).toBe(true)
    expect(CalendarSourceKindSchema.safeParse('calendar').success).toBe(true)
  })

  it('rejects invalid kind', () => {
    const result = CalendarSourceKindSchema.safeParse('other')
    expect(result.success).toBe(false)
  })
})

describe('CalendarSourceSyncStatusSchema', () => {
  it('accepts valid statuses', () => {
    for (const v of ['idle', 'ok', 'error', 'pending']) {
      expect(CalendarSourceSyncStatusSchema.safeParse(v).success).toBe(true)
    }
  })

  it('rejects invalid status', () => {
    expect(CalendarSourceSyncStatusSchema.safeParse('running').success).toBe(false)
  })
})

describe('CalendarProjectionSourceTypeSchema', () => {
  it('accepts valid source types', () => {
    for (const v of ['event', 'task', 'reminder', 'inbox_snooze', 'external_event']) {
      expect(CalendarProjectionSourceTypeSchema.safeParse(v).success).toBe(true)
    }
  })

  it('rejects invalid source type', () => {
    expect(CalendarProjectionSourceTypeSchema.safeParse('note').success).toBe(false)
  })
})

describe('CalendarProjectionVisualTypeSchema', () => {
  it('accepts valid visual types', () => {
    for (const v of ['event', 'task', 'reminder', 'snooze', 'external_event']) {
      expect(CalendarProjectionVisualTypeSchema.safeParse(v).success).toBe(true)
    }
  })

  it('rejects invalid visual type', () => {
    expect(CalendarProjectionVisualTypeSchema.safeParse('inbox_snooze').success).toBe(false)
  })
})

describe('CalendarChangeEntityTypeSchema', () => {
  it('accepts valid entity types', () => {
    for (const v of [
      'calendar_event',
      'calendar_source',
      'calendar_binding',
      'calendar_external_event',
      'projection'
    ]) {
      expect(CalendarChangeEntityTypeSchema.safeParse(v).success).toBe(true)
    }
  })

  it('rejects invalid entity type', () => {
    expect(CalendarChangeEntityTypeSchema.safeParse('note').success).toBe(false)
  })
})

describe('CreateCalendarEventSchema', () => {
  it('accepts minimal valid input with defaults', () => {
    const result = CreateCalendarEventSchema.safeParse({
      title: 'Team Sync',
      startAt: '2026-04-16T10:00:00Z'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.timezone).toBe('UTC')
      expect(result.data.isAllDay).toBe(false)
    }
  })

  it('accepts full valid input', () => {
    const result = CreateCalendarEventSchema.safeParse({
      title: 'Team Sync',
      description: 'Weekly sync',
      location: 'Zoom',
      startAt: '2026-04-16T10:00:00Z',
      endAt: '2026-04-16T11:00:00Z',
      timezone: 'America/New_York',
      isAllDay: false,
      recurrenceRule: { freq: 'WEEKLY' },
      recurrenceExceptions: [{ date: '2026-04-23' }]
    })
    expect(result.success).toBe(true)
  })

  it('accepts null description/location/endAt', () => {
    const result = CreateCalendarEventSchema.safeParse({
      title: 'Solo',
      startAt: '2026-04-16T10:00:00Z',
      description: null,
      location: null,
      endAt: null,
      recurrenceRule: null,
      recurrenceExceptions: null
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty title', () => {
    const result = CreateCalendarEventSchema.safeParse({
      title: '',
      startAt: '2026-04-16T10:00:00Z'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('title')
    }
  })

  it('rejects title over 200 chars', () => {
    const result = CreateCalendarEventSchema.safeParse({
      title: 'x'.repeat(201),
      startAt: '2026-04-16T10:00:00Z'
    })
    expect(result.success).toBe(false)
  })

  it('rejects description over 5000 chars', () => {
    const result = CreateCalendarEventSchema.safeParse({
      title: 'Test',
      startAt: '2026-04-16T10:00:00Z',
      description: 'x'.repeat(5001)
    })
    expect(result.success).toBe(false)
  })

  it('rejects location over 500 chars', () => {
    const result = CreateCalendarEventSchema.safeParse({
      title: 'Test',
      startAt: '2026-04-16T10:00:00Z',
      location: 'x'.repeat(501)
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid startAt (not ISO datetime)', () => {
    const result = CreateCalendarEventSchema.safeParse({
      title: 'Test',
      startAt: '2026-04-16'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('startAt')
    }
  })

  it('rejects empty timezone', () => {
    const result = CreateCalendarEventSchema.safeParse({
      title: 'Test',
      startAt: '2026-04-16T10:00:00Z',
      timezone: ''
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing title', () => {
    const result = CreateCalendarEventSchema.safeParse({
      startAt: '2026-04-16T10:00:00Z'
    })
    expect(result.success).toBe(false)
  })
})

describe('UpdateCalendarEventSchema', () => {
  it('accepts minimal input with only id', () => {
    const result = UpdateCalendarEventSchema.safeParse({ id: 'evt-1' })
    expect(result.success).toBe(true)
  })

  it('accepts full update', () => {
    const result = UpdateCalendarEventSchema.safeParse({
      id: 'evt-1',
      title: 'Updated',
      description: 'new',
      location: 'new place',
      startAt: '2026-04-16T12:00:00Z',
      endAt: '2026-04-16T13:00:00Z',
      timezone: 'UTC',
      isAllDay: true,
      recurrenceRule: { freq: 'DAILY' },
      recurrenceExceptions: []
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty id', () => {
    const result = UpdateCalendarEventSchema.safeParse({ id: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('id')
    }
  })

  it('rejects missing id', () => {
    const result = UpdateCalendarEventSchema.safeParse({ title: 'x' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid datetime on endAt', () => {
    const result = UpdateCalendarEventSchema.safeParse({
      id: 'evt-1',
      endAt: 'not-a-date'
    })
    expect(result.success).toBe(false)
  })
})

describe('ListCalendarEventsSchema', () => {
  it('accepts empty object with defaults', () => {
    const result = ListCalendarEventsSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.includeArchived).toBe(false)
    }
  })

  it('accepts includeArchived: true', () => {
    const result = ListCalendarEventsSchema.safeParse({ includeArchived: true })
    expect(result.success).toBe(true)
  })

  it('rejects non-boolean includeArchived', () => {
    const result = ListCalendarEventsSchema.safeParse({ includeArchived: 'yes' })
    expect(result.success).toBe(false)
  })
})

describe('GetCalendarRangeSchema', () => {
  it('accepts minimal valid input', () => {
    const result = GetCalendarRangeSchema.safeParse({
      startAt: '2026-04-01T00:00:00Z',
      endAt: '2026-04-30T23:59:59Z'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.includeUnselectedSources).toBe(false)
    }
  })

  it('accepts includeUnselectedSources', () => {
    const result = GetCalendarRangeSchema.safeParse({
      startAt: '2026-04-01T00:00:00Z',
      endAt: '2026-04-30T23:59:59Z',
      includeUnselectedSources: true
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing startAt', () => {
    const result = GetCalendarRangeSchema.safeParse({ endAt: '2026-04-30T23:59:59Z' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid endAt', () => {
    const result = GetCalendarRangeSchema.safeParse({
      startAt: '2026-04-01T00:00:00Z',
      endAt: '2026-04-30'
    })
    expect(result.success).toBe(false)
  })
})

describe('ListCalendarSourcesSchema', () => {
  it('accepts empty object', () => {
    const result = ListCalendarSourcesSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts full filter', () => {
    const result = ListCalendarSourcesSchema.safeParse({
      provider: 'google',
      kind: 'calendar',
      selectedOnly: true
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty provider', () => {
    const result = ListCalendarSourcesSchema.safeParse({ provider: '' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid kind', () => {
    const result = ListCalendarSourcesSchema.safeParse({ kind: 'group' })
    expect(result.success).toBe(false)
  })
})

describe('UpdateCalendarSourceSelectionSchema', () => {
  it('accepts valid input', () => {
    const result = UpdateCalendarSourceSelectionSchema.safeParse({
      id: 'src-1',
      isSelected: true
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty id', () => {
    const result = UpdateCalendarSourceSelectionSchema.safeParse({
      id: '',
      isSelected: true
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('id')
    }
  })

  it('rejects missing isSelected', () => {
    const result = UpdateCalendarSourceSelectionSchema.safeParse({ id: 'src-1' })
    expect(result.success).toBe(false)
  })
})

describe('CalendarProviderRequestSchema', () => {
  it('accepts valid provider', () => {
    const result = CalendarProviderRequestSchema.safeParse({ provider: 'google' })
    expect(result.success).toBe(true)
  })

  it('rejects empty provider', () => {
    const result = CalendarProviderRequestSchema.safeParse({ provider: '' })
    expect(result.success).toBe(false)
  })

  it('rejects missing provider', () => {
    const result = CalendarProviderRequestSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})
