import { describe, expect, it } from 'vitest'

import type { CalendarProjectionVisualType } from '@/services/calendar-service'

import { buildDaySummaries, type DaySummaryInput } from './day-summary'

function item(visualType: CalendarProjectionVisualType, startAt: string): DaySummaryInput {
  return { visualType, startAt }
}

describe('buildDaySummaries', () => {
  it('returns an empty object when there is nothing', () => {
    expect(buildDaySummaries([], {})).toEqual({})
  })

  it('counts notes, tasks, events, and folds reminders/snoozes/note_date into reminders', () => {
    const items = [
      item('note', '2026-04-20T09:00:00.000Z'),
      item('note', '2026-04-20T10:00:00.000Z'),
      item('note', '2026-04-20T11:00:00.000Z'),
      item('task', '2026-04-20T12:00:00.000Z'),
      item('task', '2026-04-20T13:00:00.000Z'),
      item('event', '2026-04-20T14:00:00.000Z'),
      item('external_event', '2026-04-20T15:00:00.000Z'),
      item('reminder', '2026-04-20T16:00:00.000Z'),
      item('snooze', '2026-04-20T17:00:00.000Z'),
      item('note_date', '2026-04-20T18:00:00.000Z')
    ]

    const result = buildDaySummaries(items, {})

    expect(result['2026-04-20']).toEqual({
      notes: 3,
      journal: 0,
      tasks: 2,
      events: 2,
      reminders: 3
    })
  })

  it('derives journal as 0/1 from the heatmap activity level', () => {
    const result = buildDaySummaries([item('note', '2026-04-20T09:00:00.000Z')], {
      '2026-04-20': 3,
      '2026-04-21': 0
    })

    expect(result['2026-04-20']).toMatchObject({ notes: 1, journal: 1 })
    // a journal-only day still surfaces (journal 1, no other items)
    expect(result['2026-04-21']).toBeUndefined()
  })

  it('surfaces a journal-only day with no projection items', () => {
    const result = buildDaySummaries([], { '2026-04-22': 4 })
    expect(result['2026-04-22']).toEqual({
      notes: 0,
      journal: 1,
      tasks: 0,
      events: 0,
      reminders: 0
    })
  })
})
