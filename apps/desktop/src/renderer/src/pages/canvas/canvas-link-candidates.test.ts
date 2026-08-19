import { describe, it, expect } from 'vitest'
import type { SearchResultItem } from '@memry/contracts/search-api'
import {
  urlFromQuery,
  candidatesFromEvents,
  candidatesFromFolders,
  candidatesFromProjects,
  candidatesFromSearch,
  groupCandidates,
  hasAnyCandidate
} from './canvas-link-candidates'

function searchRow(overrides: Partial<SearchResultItem>): SearchResultItem {
  return {
    id: 'x',
    type: 'note',
    title: 'Title',
    snippet: '',
    score: 1,
    normalizedScore: 1,
    matchType: 'exact',
    modifiedAt: '2026-08-17T00:00:00.000Z',
    metadata: { type: 'note', path: 'Work/Title.md', tags: [] },
    ...overrides
  } as SearchResultItem
}

describe('candidatesFromSearch', () => {
  it('links a markdown note as a note, carrying its own icon', () => {
    const [candidate] = candidatesFromSearch([
      searchRow({
        id: 'n1',
        title: 'Roadmap',
        metadata: { type: 'note', path: 'Work/Roadmap.md', tags: [], emoji: '🗺️' }
      })
    ])

    expect(candidate).toMatchObject({
      kind: 'note',
      id: 'n1',
      title: 'Roadmap',
      subtitle: 'Work/Roadmap.md',
      emoji: '🗺️',
      href: 'memry://note/n1?label=Roadmap'
    })
  })

  it('links a filed binary as a file, so it opens in the viewer not the editor', () => {
    const [candidate] = candidatesFromSearch([
      searchRow({
        id: 'p1',
        title: 'Spec.pdf',
        metadata: { type: 'note', path: 'Docs/Spec.pdf', tags: [], fileType: 'pdf' }
      })
    ])

    expect(candidate).toMatchObject({ kind: 'file', href: 'memry://file/p1?label=Spec.pdf' })
  })

  it('links a journal by its date rather than the index row id', () => {
    const [candidate] = candidatesFromSearch([
      searchRow({
        id: 'row-42',
        type: 'journal',
        title: '17 August',
        metadata: { type: 'journal', date: '2026-08-17', path: 'Journal/2026-08-17.md', tags: [] }
      })
    ])

    expect(candidate).toMatchObject({
      kind: 'journal',
      href: 'memry://journal/2026-08-17?label=17+August'
    })
  })

  it('shows a task under its project', () => {
    const [candidate] = candidatesFromSearch([
      searchRow({
        id: 't1',
        type: 'task',
        title: 'Ship it',
        metadata: {
          type: 'task',
          projectId: 'p',
          projectName: 'Launch',
          projectColor: '#f00',
          statusId: null,
          statusName: null,
          dueDate: null,
          priority: 0,
          completedAt: null
        }
      })
    ])

    expect(candidate).toMatchObject({
      kind: 'task',
      subtitle: 'Launch',
      href: 'memry://task/t1?label=Ship+it'
    })
  })

  it('keeps an inbox item type so the row can show the right icon', () => {
    const [candidate] = candidatesFromSearch([
      searchRow({
        id: 'i1',
        type: 'inbox',
        title: 'A clipped article',
        metadata: {
          type: 'inbox',
          itemType: 'link',
          sourceUrl: 'https://example.com',
          sourceTitle: 'Example',
          filedAt: null
        }
      })
    ])

    expect(candidate).toMatchObject({
      kind: 'inbox',
      itemType: 'link',
      subtitle: 'Example',
      href: 'memry://inbox/i1?label=A+clipped+article'
    })
  })
})

describe('candidatesFromEvents', () => {
  it('links an event to its day', () => {
    expect(
      candidatesFromEvents([
        { id: 'e1', title: 'Standup', startAt: '2026-08-17T09:00:00.000Z' }
      ] as never)
    ).toEqual([
      expect.objectContaining({
        kind: 'calendar_event',
        href: 'memry://calendar/event/e1?date=2026-08-17&label=Standup'
      })
    ])
  })

  it('drops an event with no start rather than offering a link that cannot open', () => {
    expect(candidatesFromEvents([{ id: 'e2', title: 'Someday', startAt: null }] as never)).toEqual(
      []
    )
  })
})

describe('candidatesFromProjects', () => {
  const projects = [
    { id: 'p1', name: 'Launch' },
    { id: 'p2', name: 'Landing page' },
    { id: 'p3', name: 'Old launch', archivedAt: '2026-01-01' }
  ]

  it('matches on name, case-insensitively', () => {
    // 'la' also matches the archived "Old launch", which the next test pins.
    expect(candidatesFromProjects(projects, 'LA').map((c) => c.id)).toEqual(['p1', 'p2'])
  })

  it('never offers an archived project', () => {
    expect(candidatesFromProjects(projects, 'old')).toEqual([])
  })

  it('returns nothing for a blank query instead of the whole list', () => {
    expect(candidatesFromProjects(projects, '  ')).toEqual([])
  })
})

describe('candidatesFromFolders', () => {
  const folders = [{ path: 'Work/Notes', icon: '📁' }, { path: 'Personal' }]

  it('titles a folder by its leaf and disambiguates with the full path', () => {
    expect(candidatesFromFolders(folders, 'notes')).toEqual([
      expect.objectContaining({
        kind: 'folder',
        title: 'Notes',
        subtitle: 'Work/Notes',
        emoji: '📁',
        href: 'memry://folder/Work%2FNotes?label=Notes'
      })
    ])
  })

  it('returns nothing for a blank query', () => {
    expect(candidatesFromFolders(folders, '')).toEqual([])
  })
})

describe('groupCandidates', () => {
  it('files every kind into its own group and reports emptiness', () => {
    const groups = groupCandidates([
      ...candidatesFromSearch([searchRow({ id: 'n1' })]),
      ...candidatesFromFolders([{ path: 'Work' }], 'work')
    ])

    expect(groups.note).toHaveLength(1)
    expect(groups.folder).toHaveLength(1)
    expect(groups.task).toHaveLength(0)
    expect(hasAnyCandidate(groups)).toBe(true)
    expect(hasAnyCandidate(groupCandidates([]))).toBe(false)
  })
})

describe('urlFromQuery', () => {
  it.each([
    ['https://example.com/docs', 'https://example.com/docs'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['mailto:kaan@example.com', 'mailto:kaan@example.com'],
    ['example.com', 'https://example.com'],
    ['example.com/a/b?c=d', 'https://example.com/a/b?c=d'],
    ['  example.com  ', 'https://example.com']
  ])('reads %s as an address', (query, expected) => {
    expect(urlFromQuery(query)).toBe(expected)
  })

  it.each([
    ['a note title', 'Meeting notes'],
    ['a single word', 'roadmap'],
    ['a filename fragment mid-typing', 'spec.'],
    ['nothing', '   ']
  ])('does not mistake %s for an address', (_label, query) => {
    expect(urlFromQuery(query)).toBeNull()
  })

  it('reads a bare filename as an address, which the https guess makes harmless', () => {
    // "Spec.md" is indistinguishable from a host at this level; the row is
    // offered alongside the real note hits rather than instead of them.
    expect(urlFromQuery('Spec.md')).toBe('https://Spec.md')
  })
})
