import { describe, expect, it } from 'vitest'
import type { SearchResultItem } from '@memry/contracts/search-api'
import type { CalendarEventSearchItem } from '@memry/contracts/calendar-api'
import {
  candidatesFromEvents,
  candidatesFromSearch,
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
      completedAt: null
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
        subtitle: 'notes/Alpha.md',
        onCanvas: false
      },
      { entityType: 'task', entityId: 't1', title: 'Ship it', subtitle: 'Inbox', onCanvas: false }
    ])
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
    const out = candidatesFromEvents(items, 'All day')

    // #then — nothing is dropped or reordered client-side
    expect(out.map((c) => c.entityId)).toEqual(['e1', 'e2'])
    expect(out.every((c) => c.entityType === 'calendar_event')).toBe(true)
    expect(out.every((c) => c.onCanvas === false)).toBe(true)
  })

  it('formats the subtitle with formatEventTime instead of a raw ISO string', () => {
    // #given — a timed event
    const out = candidatesFromEvents(
      [eventItem('e1', 'Standup', '2026-07-02T09:00:00.000Z')],
      'All day'
    )

    // #then — the subtitle is humanized
    expect(out[0].subtitle).not.toBe('2026-07-02T09:00:00.000Z')
    expect(out[0].subtitle.length).toBeGreaterThan(0)
  })

  it('uses the all-day label for all-day events', () => {
    // #given — an all-day event
    const out = candidatesFromEvents(
      [eventItem('e1', 'Offsite', '2026-07-02T00:00:00.000Z', true)],
      'All day'
    )

    // #then — the label appears in the subtitle
    expect(out[0].subtitle).toContain('All day')
  })

  it('returns an empty list for no items', () => {
    // #given / #when / #then — no events in, no candidates out
    expect(candidatesFromEvents([], 'All day')).toEqual([])
  })
})
