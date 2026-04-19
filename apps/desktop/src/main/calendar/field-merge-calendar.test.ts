import { describe, expect, it } from 'vitest'
import type { FieldClocks } from '@memry/contracts/sync-api'
import { CALENDAR_EVENT_SYNCABLE_FIELDS, mergeCalendarEventFields } from './field-merge-calendar'

describe('field-merge-calendar', () => {
  describe('CALENDAR_EVENT_SYNCABLE_FIELDS', () => {
    it('covers the design-spec field list (M3)', () => {
      // #given the M3 design pins this exact list
      // #then the constant matches
      expect([...CALENDAR_EVENT_SYNCABLE_FIELDS]).toEqual([
        'title',
        'description',
        'location',
        'startAt',
        'endAt',
        'timezone',
        'isAllDay',
        'recurrenceRule',
        'recurrenceExceptions'
      ])
    })
  })

  describe('mergeCalendarEventFields', () => {
    it('preserves both edits when devices touch different fields concurrently', () => {
      // #given device A renamed the event offline; device B moved its time online
      const local = {
        title: 'Renamed by A',
        description: null,
        location: null,
        startAt: '2026-04-20T09:00:00.000Z',
        endAt: '2026-04-20T10:00:00.000Z',
        timezone: 'UTC',
        isAllDay: false,
        recurrenceRule: null,
        recurrenceExceptions: null
      }
      const remote = {
        title: 'Original',
        description: null,
        location: null,
        startAt: '2026-04-20T11:00:00.000Z',
        endAt: '2026-04-20T12:00:00.000Z',
        timezone: 'UTC',
        isAllDay: false,
        recurrenceRule: null,
        recurrenceExceptions: null
      }
      const localFC: FieldClocks = {
        title: { deviceA: 2 },
        description: {},
        location: {},
        startAt: { deviceA: 1 },
        endAt: { deviceA: 1 },
        timezone: {},
        isAllDay: {},
        recurrenceRule: {},
        recurrenceExceptions: {}
      }
      const remoteFC: FieldClocks = {
        title: { deviceB: 1 },
        description: {},
        location: {},
        startAt: { deviceB: 2 },
        endAt: { deviceB: 2 },
        timezone: {},
        isAllDay: {},
        recurrenceRule: {},
        recurrenceExceptions: {}
      }

      // #when
      const result = mergeCalendarEventFields(local, remote, localFC, remoteFC)

      // #then local title wins (sum 2 > 1), remote times win (sum 2 > 1)
      expect(result.merged.title).toBe('Renamed by A')
      expect(result.merged.startAt).toBe('2026-04-20T11:00:00.000Z')
      expect(result.merged.endAt).toBe('2026-04-20T12:00:00.000Z')
      expect(result.hadConflicts).toBe(false)
    })

    it('reports conflict when both devices edit the same field concurrently', () => {
      // #given both devices renamed the title at the same logical tick
      const local = {
        title: 'Title A',
        description: null,
        location: null,
        startAt: '2026-04-20T09:00:00.000Z',
        endAt: null,
        timezone: 'UTC',
        isAllDay: false,
        recurrenceRule: null,
        recurrenceExceptions: null
      }
      const remote = { ...local, title: 'Title B' }
      const localFC: FieldClocks = { title: { deviceA: 1 } }
      const remoteFC: FieldClocks = { title: { deviceB: 1 } }

      // #when
      const result = mergeCalendarEventFields(local, remote, localFC, remoteFC)

      // #then equal tick-sum + concurrent + diff values → remote wins, conflict flagged
      expect(result.merged.title).toBe('Title B')
      expect(result.hadConflicts).toBe(true)
      expect(result.conflictedFields).toContain('title')
    })
  })
})
