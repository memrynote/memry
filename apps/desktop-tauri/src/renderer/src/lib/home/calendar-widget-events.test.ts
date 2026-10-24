import { describe, it, expect } from 'vitest'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import {
  toCalendarWidgetEvents,
  filterCalendarWidgetItems,
  findNextEventIndex,
  nowLinePosition
} from './calendar-widget-events'

function item(over: Partial<CalendarProjectionItem>): CalendarProjectionItem {
  return {
    projectionId: 'p1',
    sourceType: 'event',
    sourceId: 's1',
    title: 'Event',
    descriptionPreview: null,
    startAt: '2026-06-24T09:30:00.000Z',
    endAt: null,
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'event',
    editability: 'editable',
    source: {} as CalendarProjectionItem['source'],
    binding: null,
    snoozeOffsetMinutes: null,
    ...over
  } as CalendarProjectionItem
}

describe('toCalendarWidgetEvents', () => {
  it('drops tasks and sorts by start time', () => {
    const events = toCalendarWidgetEvents(
      [
        item({ projectionId: 'b', startAt: '2026-06-24T11:00:00.000Z' }),
        item({ projectionId: 'task', visualType: 'task', startAt: '2026-06-24T08:00:00.000Z' }),
        item({ projectionId: 'a', startAt: '2026-06-24T09:30:00.000Z' })
      ],
      '24h'
    )
    expect(events.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('computes duration in minutes, null for all-day or no end', () => {
    const events = toCalendarWidgetEvents(
      [
        item({
          projectionId: 'timed',
          startAt: '2026-06-24T09:30:00.000Z',
          endAt: '2026-06-24T09:45:00.000Z'
        }),
        item({ projectionId: 'allday', startAt: '2026-06-24T00:00:00.000Z', isAllDay: true }),
        item({ projectionId: 'noend', startAt: '2026-06-24T10:00:00.000Z' })
      ],
      '24h'
    )
    const byId = (id: string) => events.find((e) => e.id === id)
    expect(byId('timed')?.durationMinutes).toBe(15)
    expect(byId('allday')?.durationMinutes).toBeNull()
    expect(byId('noend')?.durationMinutes).toBeNull()
  })

  it('labels external events with their provider', () => {
    const [ev] = toCalendarWidgetEvents(
      [
        item({
          visualType: 'external_event',
          source: { provider: 'google' } as CalendarProjectionItem['source']
        })
      ],
      '24h'
    )
    expect(ev.metaLabel).toBe('Google')
  })
})

describe('filterCalendarWidgetItems', () => {
  it('drops tasks and keeps everything else, so the widget and the Home header agree (#1956)', () => {
    const filtered = filterCalendarWidgetItems([
      item({ projectionId: 'task', visualType: 'task' }),
      item({ projectionId: 'reminder', visualType: 'reminder' }),
      item({ projectionId: 'event', visualType: 'event' })
    ])
    expect(filtered.map((i) => i.projectionId)).toEqual(['reminder', 'event'])
  })
})

describe('findNextEventIndex / nowLinePosition', () => {
  const events = toCalendarWidgetEvents(
    [
      item({ projectionId: 'a', startAt: '2026-06-24T09:30:00.000Z' }),
      item({ projectionId: 'b', startAt: '2026-06-24T11:00:00.000Z' })
    ],
    '24h'
  )
  const now = new Date('2026-06-24T10:42:00.000Z').getTime()

  it('next up is the first future event', () => {
    expect(findNextEventIndex(events, now)).toBe(1)
    expect(findNextEventIndex(events, new Date('2026-06-24T23:00:00.000Z').getTime())).toBe(-1)
  })

  it('now line sits between a past and a future event', () => {
    expect(nowLinePosition(events, now)).toBe(1)
    expect(nowLinePosition(events, new Date('2026-06-24T08:00:00.000Z').getTime())).toBe(0)
    expect(nowLinePosition(events, new Date('2026-06-24T23:00:00.000Z').getTime())).toBe(2)
  })
})
