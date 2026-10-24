import { describe, expect, it } from 'vitest'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import { filterCalendarItems } from './calendar-search-filter'

function makeItem(overrides: Partial<CalendarProjectionItem>): CalendarProjectionItem {
  return {
    projectionId: overrides.projectionId ?? 'p',
    sourceType: 'event',
    sourceId: 's',
    title: '',
    descriptionPreview: null,
    startAt: '2026-01-01T00:00:00.000Z',
    endAt: null,
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'event',
    editability: { canMove: true, canResize: true, canEditText: true, canDelete: true },
    source: {
      provider: null,
      calendarSourceId: null,
      title: null,
      color: null,
      kind: null,
      isMemryManaged: true
    },
    binding: null,
    snoozeOffsetMinutes: null,
    ...overrides
  }
}

const NOW = new Date('2026-06-01T00:00:00.000Z').getTime()

describe('filterCalendarItems', () => {
  it('returns nothing for a blank query', () => {
    const items = [makeItem({ title: 'Standup' })]
    expect(filterCalendarItems(items, '   ', NOW)).toEqual([])
  })

  it('matches title and description case-insensitively', () => {
    const items = [
      makeItem({ projectionId: 'a', title: 'Team STANDUP' }),
      makeItem({ projectionId: 'b', title: 'Lunch', descriptionPreview: 'weekly standup notes' }),
      makeItem({ projectionId: 'c', title: 'Gym' })
    ]
    const ids = filterCalendarItems(items, 'standup', NOW).map((i) => i.projectionId)
    expect(ids).toEqual(['a', 'b'])
  })

  it('sorts matches by proximity to now', () => {
    const items = [
      makeItem({ projectionId: 'far', title: 'Trip', startAt: '2027-08-08T00:00:00.000Z' }),
      makeItem({ projectionId: 'near', title: 'Trip', startAt: '2026-06-05T00:00:00.000Z' })
    ]
    expect(filterCalendarItems(items, 'trip', NOW).map((i) => i.projectionId)).toEqual([
      'near',
      'far'
    ])
  })

  it('caps the result count', () => {
    const items = Array.from({ length: 30 }, (_, n) =>
      makeItem({ projectionId: `p${n}`, title: 'Repeat' })
    )
    expect(filterCalendarItems(items, 'repeat', NOW, 5)).toHaveLength(5)
  })
})
