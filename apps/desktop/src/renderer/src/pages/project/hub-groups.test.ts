import { describe, it, expect } from 'vitest'
import type { ProjectLinkedEvent, ProjectLinkedNote } from '@memry/rpc/tasks'
import { groupEventsByStart, groupNotesByModified, periodLabelKey } from './hub-groups'

const note = (id: string, modifiedAt: Date): ProjectLinkedNote => ({
  id,
  title: id,
  emoji: null,
  modifiedAt: modifiedAt.toISOString(),
  pinned: false
})

const event = (id: string, startAt: Date): ProjectLinkedEvent => ({
  id,
  title: id,
  startAt: startAt.toISOString(),
  endAt: null,
  isAllDay: false
})

const at = (dayOffset: number, hour = 12): Date => {
  const date = new Date()
  date.setHours(hour, 0, 0, 0)
  date.setDate(date.getDate() + dayOffset)
  return date
}

describe('groupNotesByModified', () => {
  it('buckets by modifiedAt and drops empty groups', () => {
    const groups = groupNotesByModified([
      note('old', at(-9)),
      note('today', at(0)),
      note('yesterday', at(-1))
    ])

    expect(groups.map((group) => group.period)).toEqual(['TODAY', 'YESTERDAY', 'OLDER'])
    expect(groups[0].items.map((item) => item.id)).toEqual(['today'])
  })

  it('returns nothing for an empty list rather than three empty sections', () => {
    expect(groupNotesByModified([])).toEqual([])
  })
})

describe('groupEventsByStart', () => {
  it('splits today, tomorrow, upcoming and past', () => {
    const groups = groupEventsByStart([
      event('past', at(-3)),
      event('upcoming', at(5)),
      event('tomorrow', at(1)),
      event('today', at(0))
    ])

    expect(groups.map((group) => group.period)).toEqual(['TODAY', 'TOMORROW', 'UPCOMING', 'PAST'])
  })

  it('orders the future soonest-first and the past most-recent-first', () => {
    const groups = groupEventsByStart([
      event('later-today', at(0, 20)),
      event('earlier-today', at(0, 8)),
      event('long-ago', at(-10)),
      event('recent', at(-2))
    ])

    const today = groups.find((group) => group.period === 'TODAY')
    const past = groups.find((group) => group.period === 'PAST')
    expect(today?.items.map((item) => item.id)).toEqual(['earlier-today', 'later-today'])
    expect(past?.items.map((item) => item.id)).toEqual(['recent', 'long-ago'])
  })

  it('keeps an event earlier today out of the past bucket', () => {
    const groups = groupEventsByStart([event('this-morning', at(0, 1))], at(0, 23))
    expect(groups.map((group) => group.period)).toEqual(['TODAY'])
  })
})

describe('periodLabelKey', () => {
  it('maps a period to its translation key', () => {
    expect(periodLabelKey('OLDER')).toBe('projectHub.groups.older')
    expect(periodLabelKey('UPCOMING')).toBe('projectHub.groups.upcoming')
  })
})
