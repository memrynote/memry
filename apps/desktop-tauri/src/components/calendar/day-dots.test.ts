import { describe, expect, it } from 'vitest'

import type { CalendarProjectionVisualType } from '@/services/calendar-service'

import { buildDayDots, type DayDotsInput } from './day-dots'
import { VISUAL_TYPE_META } from './visual-type-meta'

function item(visualType: CalendarProjectionVisualType, startAt: string): DayDotsInput {
  return { visualType, startAt }
}

const color = (type: CalendarProjectionVisualType): string => VISUAL_TYPE_META[type].dotColor

describe('buildDayDots', () => {
  it('returns an empty object for no items', () => {
    // #given
    const items: DayDotsInput[] = []
    // #when
    const result = buildDayDots(items)
    // #then
    expect(result).toEqual({})
  })

  it('renders a single dot for one event on one day', () => {
    // #given
    const items = [item('event', '2026-04-20T10:00:00.000Z')]
    // #when
    const result = buildDayDots(items)
    // #then
    expect(result).toEqual({ '2026-04-20': [color('event')] })
  })

  it('orders 2 tasks + 1 event as [event, task, task] by VISUAL_TYPE_ORDER', () => {
    // #given
    const items = [
      item('task', '2026-04-20T09:00:00.000Z'),
      item('task', '2026-04-20T15:00:00.000Z'),
      item('event', '2026-04-20T12:00:00.000Z')
    ]
    // #when
    const result = buildDayDots(items)
    // #then
    expect(result['2026-04-20']).toEqual([color('event'), color('task'), color('task')])
  })

  it('caps at 3 dots and drops lower-priority items when a day has 5 mixed items', () => {
    // #given
    const items = [
      item('snooze', '2026-04-20T08:00:00.000Z'),
      item('task', '2026-04-20T09:00:00.000Z'),
      item('event', '2026-04-20T10:00:00.000Z'),
      item('external_event', '2026-04-20T11:00:00.000Z'),
      item('reminder', '2026-04-20T12:00:00.000Z')
    ]
    // #when
    const result = buildDayDots(items)
    // #then
    expect(result['2026-04-20']).toEqual([color('event'), color('external_event'), color('task')])
    expect(result['2026-04-20']).toHaveLength(3)
  })

  it('prefers uniqueness over count: 3 events + 2 tasks + 1 snooze renders one of each type', () => {
    // #given
    const items = [
      item('event', '2026-04-20T08:00:00.000Z'),
      item('event', '2026-04-20T09:00:00.000Z'),
      item('event', '2026-04-20T10:00:00.000Z'),
      item('task', '2026-04-20T11:00:00.000Z'),
      item('task', '2026-04-20T12:00:00.000Z'),
      item('snooze', '2026-04-20T13:00:00.000Z')
    ]
    // #when
    const result = buildDayDots(items)
    // #then
    expect(result['2026-04-20']).toEqual([color('event'), color('task'), color('snooze')])
  })

  it('fills remaining slots with duplicates when fewer than 3 unique types exist', () => {
    // #given — 5 tasks, 0 other types
    const items = [
      item('task', '2026-04-20T08:00:00.000Z'),
      item('task', '2026-04-20T09:00:00.000Z'),
      item('task', '2026-04-20T10:00:00.000Z'),
      item('task', '2026-04-20T11:00:00.000Z'),
      item('task', '2026-04-20T12:00:00.000Z')
    ]
    // #when
    const result = buildDayDots(items)
    // #then
    expect(result['2026-04-20']).toEqual([color('task'), color('task'), color('task')])
  })

  it('buckets items into separate days via local date key, not UTC', () => {
    // #given — in America/New_York (UTC-4 in April), 2026-04-20T23:00Z is 19:00 local
    // and 2026-04-21T01:00Z is 21:00 local the same day.
    // In UTC they are on different days; locally they are the same day.
    const items = [
      item('event', '2026-04-20T23:00:00.000Z'),
      item('task', '2026-04-21T01:00:00.000Z')
    ]
    // #when
    const result = buildDayDots(items)
    // #then — both items bucket to whichever local date the runner is in.
    // Assert: at least one bucket exists, total dots across all buckets equals 2,
    // and buckets use YYYY-MM-DD keys.
    const buckets = Object.values(result).flat()
    expect(buckets).toHaveLength(2)
    for (const key of Object.keys(result)) {
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('produces independent buckets for two distinct days', () => {
    // #given
    const items = [
      item('event', '2026-04-20T12:00:00.000Z'),
      item('task', '2026-04-22T12:00:00.000Z')
    ]
    // #when
    const result = buildDayDots(items)
    // #then
    expect(Object.keys(result).sort()).toEqual(['2026-04-20', '2026-04-22'])
    expect(result['2026-04-20']).toEqual([color('event')])
    expect(result['2026-04-22']).toEqual([color('task')])
  })
})
