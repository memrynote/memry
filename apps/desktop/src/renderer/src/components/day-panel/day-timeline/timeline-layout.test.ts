import { describe, expect, it } from 'vitest'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import {
  buildDayTimeline,
  initialScrollMinutes,
  packColumns,
  pastMinutes,
  resizeSteps,
  type TimelineItem
} from './timeline-layout'

const DATE = '2026-04-14'

function localIso(hour: number, minute = 0, day = 14): string {
  return new Date(2026, 3, day, hour, minute).toISOString()
}

function projection(overrides: Partial<CalendarProjectionItem>): CalendarProjectionItem {
  return {
    projectionId: 'p',
    sourceType: 'event',
    sourceId: 's',
    title: 'Item',
    descriptionPreview: null,
    startAt: localIso(9),
    endAt: null,
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'event',
    editability: { canMove: true, canResize: true, canEditText: true, canDelete: true },
    source: { provider: null, calendarSourceId: null, title: null, color: null, kind: 'memry' },
    binding: null,
    ...overrides
  } as CalendarProjectionItem
}

function item(id: string, startMin: number, endMin: number): TimelineItem {
  return {
    id,
    sourceId: id,
    kind: 'event',
    title: id,
    startMin,
    endMin,
    item: projection({ projectionId: id })
  }
}

describe('buildDayTimeline', () => {
  it('positions items in local minutes, gives a task without a duration 30 minutes and leaves untimed tasks out', () => {
    const model = buildDayTimeline(
      [
        projection({ projectionId: 'e', startAt: localIso(9), endAt: localIso(10, 30) }),
        projection({
          projectionId: 't',
          sourceType: 'task',
          visualType: 'task',
          startAt: localIso(14)
        }),
        projection({ projectionId: 'a', isAllDay: true, startAt: localIso(0) }),
        projection({ projectionId: 'u', visualType: 'task', isAllDay: true, startAt: localIso(0) })
      ],
      DATE,
      { includeTasks: true }
    )
    expect(model.timed.map(({ id, startMin, endMin }) => ({ id, startMin, endMin }))).toEqual([
      { id: 'e', startMin: 540, endMin: 630 },
      { id: 't', startMin: 840, endMin: 870 }
    ])
    expect(model.allDay.map((i) => i.projectionId)).toEqual(['a'])
  })

  it('clips an item that runs past midnight and drops tasks when tasks are off', () => {
    const model = buildDayTimeline(
      [
        projection({ projectionId: 'late', startAt: localIso(23), endAt: localIso(1, 0, 15) }),
        projection({ projectionId: 't', visualType: 'task', sourceType: 'task' })
      ],
      DATE,
      { includeTasks: false }
    )
    expect(model.timed.map(({ id, startMin, endMin }) => ({ id, startMin, endMin }))).toEqual([
      { id: 'late', startMin: 1380, endMin: 1440 }
    ])
  })
})

describe('packColumns', () => {
  it('puts overlapping items side by side and leaves a separate item full width', () => {
    const placed = packColumns([
      item('a', 540, 600),
      item('b', 570, 630),
      item('c', 600, 660),
      item('d', 720, 750)
    ])
    expect(placed.map(({ id, column, columns }) => ({ id, column, columns }))).toEqual([
      { id: 'a', column: 0, columns: 2 },
      { id: 'b', column: 1, columns: 2 },
      { id: 'c', column: 0, columns: 2 },
      { id: 'd', column: 0, columns: 1 }
    ])
  })
})

describe('resizeSteps', () => {
  const H = 44

  it('steps 30 min, then 1 h, then whole hours', () => {
    expect(resizeSteps(30, 5, H)).toBe(30)
    expect(resizeSteps(30, 22, H)).toBe(60)
    expect(resizeSteps(60, 44, H)).toBe(120)
    expect(resizeSteps(60, 100, H)).toBe(180)
    expect(resizeSteps(120, -80, H)).toBe(30)
  })

  it('stops at the end of the day', () => {
    expect(resizeSteps(60, 44 * 5, H, 150)).toBe(120)
    expect(resizeSteps(30, 44 * 5, H, 30)).toBe(30)
  })
})

describe('opening position and past hours', () => {
  const now = new Date(2026, 3, 14, 13, 40)

  it('opens today at now - 15 min and any other day at 08:00', () => {
    expect(initialScrollMinutes('2026-04-14', '2026-04-14', now)).toBe(805)
    expect(initialScrollMinutes('2026-04-15', '2026-04-14', now)).toBe(480)
    expect(initialScrollMinutes('2026-04-14', '2026-04-14', new Date(2026, 3, 14, 0, 5))).toBe(0)
  })

  it('dims the elapsed part of today and all of a past day', () => {
    expect(pastMinutes('2026-04-14', '2026-04-14', now)).toBe(820)
    expect(pastMinutes('2026-04-13', '2026-04-14', now)).toBe(1440)
    expect(pastMinutes('2026-04-15', '2026-04-14', now)).toBe(0)
  })
})
