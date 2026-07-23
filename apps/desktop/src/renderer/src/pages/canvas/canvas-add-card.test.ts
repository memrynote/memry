import { describe, expect, it } from 'vitest'
import type { SearchResultItem } from '@memry/contracts/search-api'
import type { CalendarEventSearchItem } from '@memry/contracts/calendar-api'
import {
  candidatesFromEvents,
  candidatesFromSearch,
  formatDueDate,
  formatShortDate,
  groupCandidates,
  markOnCanvas,
  onCanvasKeys,
  revealScroll
} from './canvas-add-card'
import { entityKey } from './canvas-cards'

function noteHit(id: string, title: string, fileType?: string): SearchResultItem {
  return {
    id,
    type: 'note',
    title,
    snippet: '',
    score: 1,
    normalizedScore: 1,
    matchType: 'exact',
    modifiedAt: '2026-07-01T00:00:00.000Z',
    metadata: {
      type: 'note',
      path: `notes/${title}.md`,
      tags: [],
      createdAt: '2026-06-01T00:00:00.000Z',
      ...(fileType ? { fileType } : {})
    }
  } as SearchResultItem
}

function taskHit(id: string, title: string): SearchResultItem {
  return {
    id,
    type: 'task',
    title,
    snippet: '',
    score: 1,
    normalizedScore: 1,
    matchType: 'exact',
    modifiedAt: '2026-07-01T00:00:00.000Z',
    metadata: {
      type: 'task',
      projectId: 'p1',
      projectName: 'Inbox',
      projectColor: '#fff',
      statusId: null,
      statusName: null,
      dueDate: null,
      priority: 0,
      completedAt: null,
      createdAt: '2026-06-01T00:00:00.000Z'
    }
  } as SearchResultItem
}

describe('candidatesFromSearch', () => {
  it('keeps markdown notes and tasks', () => {
    const out = candidatesFromSearch([noteHit('n1', 'Alpha'), taskHit('t1', 'Ship it')])
    expect(out).toEqual([
      {
        entityType: 'note',
        entityId: 'n1',
        title: 'Alpha',
        detail: {
          type: 'note',
          emoji: null,
          path: 'notes/Alpha.md',
          createdAt: '2026-06-01T00:00:00.000Z'
        },
        onCanvas: false
      },
      {
        entityType: 'task',
        entityId: 't1',
        title: 'Ship it',
        detail: {
          type: 'task',
          projectName: 'Inbox',
          projectColor: '#fff',
          statusName: null,
          priority: 0,
          dueDate: null,
          completed: false,
          createdAt: '2026-06-01T00:00:00.000Z'
        },
        onCanvas: false
      }
    ])
  })

  it('carries the fields a row renders: icon, status and dates', () => {
    // #given — a note with its own icon and a completed, prioritised task
    const note = noteHit('n1', 'Alpha')
    ;(note.metadata as { emoji?: string | null }).emoji = '📌'
    const task = taskHit('t1', 'Ship it')
    Object.assign(task.metadata, {
      statusName: 'In progress',
      priority: 4,
      dueDate: '2026-08-01',
      completedAt: '2026-07-20T00:00:00.000Z'
    })

    // #when — they become candidates
    const [noteCandidate, taskCandidate] = candidatesFromSearch([note, task])

    // #then — nothing the row needs was flattened away
    expect(noteCandidate.detail).toMatchObject({ emoji: '📌' })
    expect(taskCandidate.detail).toMatchObject({
      statusName: 'In progress',
      priority: 4,
      dueDate: '2026-08-01',
      completed: true
    })
  })

  it('treats a missing createdAt from an older main process as absent, not a crash', () => {
    // #given — a note hit predating the createdAt field
    const note = noteHit('n1', 'Alpha')
    delete (note.metadata as { createdAt?: string | null }).createdAt

    // #when / #then — the candidate still builds, with a null date
    expect(candidatesFromSearch([note])[0].detail).toMatchObject({ createdAt: null })
  })

  it('drops filed binaries masquerading as notes (#800)', () => {
    expect(candidatesFromSearch([noteHit('n2', 'Scan', 'pdf')])).toEqual([])
  })

  it('drops journal and inbox hits', () => {
    const journal = {
      ...noteHit('j1', 'Day'),
      type: 'journal',
      metadata: { type: 'journal', date: '2026-07-01', path: 'j/1.md', tags: [] }
    } as unknown as SearchResultItem
    const inbox = {
      ...noteHit('i1', 'Clipped'),
      type: 'inbox',
      metadata: {
        type: 'inbox',
        itemType: 'link',
        sourceUrl: null,
        sourceTitle: null,
        filedAt: null
      }
    } as unknown as SearchResultItem
    expect(candidatesFromSearch([journal, inbox])).toEqual([])
  })
})

describe('markOnCanvas + groupCandidates', () => {
  it('flags entities already carded and groups by type', () => {
    const keys = onCanvasKeys([{ entityType: 'task', entityId: 't1' }])
    expect(keys.has(entityKey('task', 't1'))).toBe(true)

    const marked = markOnCanvas(
      candidatesFromSearch([noteHit('n1', 'Alpha'), taskHit('t1', 'Ship it')]),
      keys
    )
    const groups = groupCandidates(marked)
    expect(groups.note[0].onCanvas).toBe(false)
    expect(groups.task[0].onCanvas).toBe(true)
    expect(groups.calendar_event).toEqual([])
  })
})

describe('revealScroll', () => {
  it('centers the viewport on the card', () => {
    // Card centered at (500, 400); an 800x600 viewport at zoom 1 centers it
    // when the scene point (500,400) maps to viewport (400,300).
    expect(
      revealScroll({ x: 400, y: 300, width: 200, height: 200 }, { width: 800, height: 600 }, 1)
    ).toEqual({ scrollX: -100, scrollY: -100 })
  })

  it('accounts for zoom', () => {
    expect(
      revealScroll({ x: 0, y: 0, width: 0, height: 0 }, { width: 800, height: 600 }, 2)
    ).toEqual({ scrollX: 200, scrollY: 150 })
  })

  it('treats zoom 0 as 1 rather than dividing by zero', () => {
    const out = revealScroll({ x: 0, y: 0, width: 0, height: 0 }, { width: 800, height: 600 }, 0)
    expect(Number.isFinite(out.scrollX)).toBe(true)
  })
})

describe('candidatesFromEvents (#869)', () => {
  function eventItem(
    id: string,
    title: string,
    startAt: string,
    isAllDay = false
  ): CalendarEventSearchItem {
    return { id, title, startAt, endAt: null, isAllDay }
  }

  it('maps every event through, trusting main to have filtered and ordered', () => {
    // #given — two events in the order main returned them
    const items = [
      eventItem('e1', 'Standup', '2026-07-22T09:00:00.000Z'),
      eventItem('e2', 'Retro', '2023-01-02T09:00:00.000Z')
    ]

    // #when — we map them to candidates
    const out = candidatesFromEvents(items)

    // #then — nothing is dropped or reordered client-side
    expect(out.map((c) => c.entityId)).toEqual(['e1', 'e2'])
    expect(out.every((c) => c.entityType === 'calendar_event')).toBe(true)
    expect(out.every((c) => c.onCanvas === false)).toBe(true)
  })

  it('carries the raw start so the row can format it, all-day flag included', () => {
    // #given — one timed and one all-day event
    const out = candidatesFromEvents([
      eventItem('e1', 'Standup', '2026-07-02T09:00:00.000Z'),
      eventItem('e2', 'Offsite', '2026-07-02T00:00:00.000Z', true)
    ])

    // #then — formatting is the row's job now, not the candidate's
    expect(out[0].detail).toEqual({
      type: 'calendar_event',
      startAt: '2026-07-02T09:00:00.000Z',
      isAllDay: false
    })
    expect(out[1].detail).toMatchObject({ isAllDay: true })
  })

  it('returns an empty list for no items', () => {
    // #given / #when / #then — no events in, no candidates out
    expect(candidatesFromEvents([])).toEqual([])
  })
})

describe('date formatting', () => {
  it('omits the year for the current year and includes it otherwise', () => {
    // #given — a fixed "now" in 2026
    const now = new Date('2026-07-23T12:00:00.000Z')

    // #when / #then — same-year dates stay short, older ones carry the year
    expect(formatShortDate('2026-07-02T09:00:00.000Z', now)).not.toContain('2026')
    expect(formatShortDate('2024-07-02T09:00:00.000Z', now)).toContain('2024')
  })

  it('keeps a date-only due date on its own day regardless of timezone', () => {
    // #given — a due date that `new Date()` would parse as the previous day
    // west of Greenwich (see the parseDueDate off-by-one)
    const formatted = formatDueDate('2026-07-10', new Date('2026-07-23T12:00:00.000Z'))

    // #then — the 10th, not the 9th
    expect(formatted).toContain('10')
  })

  it('returns null for missing or unparseable values', () => {
    // #given / #when / #then — nothing to show beats "Invalid Date"
    expect(formatShortDate(null)).toBeNull()
    expect(formatShortDate(undefined)).toBeNull()
    expect(formatShortDate('not-a-date')).toBeNull()
    expect(formatDueDate(null)).toBeNull()
  })
})
