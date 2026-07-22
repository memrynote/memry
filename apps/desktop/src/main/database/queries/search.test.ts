import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ContentType, SearchQuery, SearchResultItem } from '@memry/contracts/search-api'

const { fuzzySearchTitlesMock, loggerWarnMock } = vi.hoisted(() => ({
  fuzzySearchTitlesMock: vi.fn(),
  loggerWarnMock: vi.fn()
}))

vi.mock('../../lib/fuzzysort-search', () => ({
  fuzzySearchTitles: fuzzySearchTitlesMock
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    warn: loggerWarnMock
  })
}))

import { getSearchStats, quickSearch, searchAll } from './search'

type QueuedValue<T> = T | Error

function createDbMock() {
  const allQueue: Array<QueuedValue<unknown[]>> = []
  const getQueue: Array<QueuedValue<unknown | undefined>> = []
  return {
    allQueue,
    getQueue,
    all: vi.fn(() => {
      const next = allQueue.shift()
      if (next instanceof Error) throw next
      return next ?? []
    }) as Mock,
    get: vi.fn(() => {
      const next = getQueue.shift()
      if (next instanceof Error) throw next
      return next
    }) as Mock
  }
}

/** Flattens a drizzle SQL object into its literal text and bound params. */
function sqlParts(query: unknown): { text: string; params: unknown[] } {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? []
  let text = ''
  const params: unknown[] = []
  const walk = (chunk: unknown): void => {
    // Bound values ride in the chunk list as bare primitives; only StringChunk
    // (a `value: string[]`) and nested SQL carry literal text.
    if (chunk === null || typeof chunk !== 'object') {
      params.push(chunk)
      return
    }
    const value = (chunk as { value?: unknown }).value
    if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
      text += value.join('')
      return
    }
    const nested = (chunk as { queryChunks?: unknown[] }).queryChunks
    if (nested) {
      nested.forEach(walk)
      return
    }
    params.push(value ?? chunk)
  }
  chunks.forEach(walk)
  return { text, params }
}

function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    text: 'budget',
    types: [],
    tags: [],
    dateRange: null,
    projectId: null,
    folderPath: null,
    limit: 5,
    offset: 0,
    ...overrides
  }
}

function noteRows(count: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `note-${index + 1}`,
    title: `Note ${index + 1}`,
    path: `projects/note-${index + 1}.md`,
    date: null,
    emoji: ':note:',
    wordCount: 10 + index,
    modifiedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    rank: -(10 - index),
    snippet: `note snippet ${index + 1}`,
    ...overrides
  }))
}

function journalRows(count: number) {
  return noteRows(count, {
    id: 'journal-1',
    title: 'Journal',
    path: 'journal/2026-01-01.md',
    date: '2026-01-01',
    wordCount: 40,
    snippet: 'journal snippet'
  }).map((row, index) => ({ ...row, id: `journal-${index + 1}` }))
}

function taskRows(count: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index + 1}`,
    title: `Task ${index + 1}`,
    projectId: index === 0 ? 'project-a' : 'project-b',
    projectName: index === 0 ? 'Alpha' : 'Beta',
    projectColor: index === 0 ? 'blue' : 'green',
    statusId: index === 0 ? 'status-a' : null,
    statusName: index === 0 ? 'Doing' : null,
    dueDate: index === 0 ? '2026-01-10' : null,
    priority: index + 1,
    completedAt: null,
    modifiedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    rank: -(8 - index),
    snippet: `task snippet ${index + 1}`,
    ...overrides
  }))
}

function inboxRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `inbox-${index + 1}`,
    title: `Inbox ${index + 1}`,
    type: index === 0 ? 'link' : 'text',
    sourceUrl: index === 0 ? 'https://example.com' : null,
    sourceTitle: index === 0 ? 'Example' : null,
    filedAt: index === 0 ? '2026-01-05T00:00:00.000Z' : null,
    modifiedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    rank: -(6 - index),
    snippet: `inbox snippet ${index + 1}`
  }))
}

function fuzzyResult(id: string, type: ContentType): SearchResultItem {
  return {
    id,
    type,
    title: `${type} fuzzy`,
    snippet: '',
    score: 0.4,
    normalizedScore: 0.4,
    matchType: 'fuzzy',
    modifiedAt: '2026-01-09T00:00:00.000Z',
    metadata:
      type === 'task'
        ? {
            type: 'task',
            projectId: 'project-a',
            projectName: 'Alpha',
            projectColor: 'blue',
            statusId: null,
            statusName: null,
            dueDate: null,
            priority: 1,
            completedAt: null
          }
        : type === 'inbox'
          ? {
              type: 'inbox',
              itemType: 'text',
              sourceUrl: null,
              sourceTitle: null,
              filedAt: null
            }
          : type === 'journal'
            ? { type: 'journal', date: '2026-01-09', path: 'journal/2026-01-09.md', tags: [] }
            : { type: 'note', path: 'projects/fuzzy.md', tags: [], emoji: null }
  }
}

describe('cross-type search queries', () => {
  let indexDb: ReturnType<typeof createDbMock>
  let dataDb: ReturnType<typeof createDbMock>

  beforeEach(() => {
    vi.clearAllMocks()
    fuzzySearchTitlesMock.mockReturnValue([])
    indexDb = createDbMock()
    dataDb = createDbMock()
  })

  it('returns an empty response without touching the databases when query text is empty', () => {
    const response = searchAll(indexDb, dataDb, query({ text: '   ' }))

    expect(response).toEqual({ groups: [], totalCount: 0, queryTimeMs: 0 })
    expect(indexDb.all).not.toHaveBeenCalled()
    expect(dataDb.all).not.toHaveBeenCalled()
  })

  it('maps exact FTS rows for notes, journals, tasks, and inbox items', () => {
    indexDb.allQueue.push(noteRows(3), journalRows(3))
    dataDb.allQueue.push(taskRows(3), inboxRows(3))

    const response = searchAll(indexDb, dataDb, query({ limit: 3 }))

    expect(response.totalCount).toBe(12)
    expect(response.groups.map((group) => group.type)).toEqual(['note', 'journal', 'task', 'inbox'])
    expect(response.groups[0].results[0]).toMatchObject({
      id: 'note-1',
      type: 'note',
      title: 'Note 1',
      snippet: 'note snippet 1',
      metadata: { type: 'note', path: 'projects/note-1.md', emoji: ':note:', wordCount: 10 }
    })
    expect(response.groups[1].results[0].metadata).toMatchObject({
      type: 'journal',
      date: '2026-01-01',
      path: 'journal/2026-01-01.md'
    })
    expect(response.groups[2].results[0].metadata).toMatchObject({
      type: 'task',
      projectId: 'project-a',
      projectName: 'Alpha',
      statusName: 'Doing',
      dueDate: '2026-01-10'
    })
    expect(response.groups[3].results[0].metadata).toMatchObject({
      type: 'inbox',
      itemType: 'link',
      sourceUrl: 'https://example.com',
      filedAt: '2026-01-05T00:00:00.000Z'
    })
    expect(fuzzySearchTitlesMock).not.toHaveBeenCalled()
  })

  it('applies tags, date, folder, and project filters before merging fuzzy fallback results', () => {
    indexDb.allQueue.push(
      noteRows(2, {
        path: 'projects/plans/note-1.md',
        modifiedAt: '2026-01-05T00:00:00.000Z'
      }),
      [{ id: 'note-1' }],
      [{ id: 'note-fuzzy', title: 'Budget fuzzy', path: 'projects/plans/fuzzy.md', emoji: null }]
    )
    fuzzySearchTitlesMock
      .mockReturnValueOnce([fuzzyResult('note-fuzzy', 'note')])
      .mockReturnValueOnce([fuzzyResult('task-fuzzy', 'task')])

    const response = searchAll(
      indexDb,
      dataDb,
      query({
        types: ['note'],
        tags: ['work'],
        dateRange: {
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-10T00:00:00.000Z'
        },
        folderPath: 'projects/plans',
        limit: 2
      })
    )

    expect(response.groups).toHaveLength(1)
    expect(response.groups[0].results.map((result) => result.id)).toEqual(['note-1', 'note-fuzzy'])

    dataDb.allQueue.push(
      taskRows(2),
      [{ id: 'task-1' }],
      [
        {
          id: 'task-fuzzy',
          title: 'Task fuzzy',
          modifiedAt: '2026-01-06T00:00:00.000Z',
          projectId: 'project-a',
          projectName: 'Alpha',
          projectColor: 'blue',
          statusId: null,
          statusName: null,
          dueDate: null,
          priority: 1,
          completedAt: null
        }
      ]
    )

    const taskResponse = searchAll(
      indexDb,
      dataDb,
      query({
        types: ['task'],
        tags: ['work'],
        dateRange: {
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-10T00:00:00.000Z'
        },
        projectId: 'project-a',
        limit: 2
      })
    )

    expect(taskResponse.groups[0].results.map((result) => result.id)).toEqual([
      'task-1',
      'task-fuzzy'
    ])
    expect(fuzzySearchTitlesMock).toHaveBeenCalledTimes(2)
  })

  it('filters note file types inside the FTS query so the cap counts eligible rows', () => {
    indexDb.allQueue.push(noteRows(5))

    searchAll(indexDb, dataDb, query({ types: ['note'], noteFileTypes: ['markdown'] }))

    const fts = sqlParts(indexDb.all.mock.calls[0][0])
    expect(fts.text).toContain("COALESCE(nc.file_type, 'markdown') IN (")
    expect(fts.params).toContain('markdown')
    // The eligibility test must sit above LIMIT, not after it.
    expect(fts.text.indexOf('COALESCE')).toBeLessThan(fts.text.indexOf('LIMIT'))
  })

  it('filters fuzzy fallback candidates by note file type too', () => {
    indexDb.allQueue.push(noteRows(1), [])

    searchAll(indexDb, dataDb, query({ types: ['note'], noteFileTypes: ['markdown'] }))

    const titles = sqlParts(indexDb.all.mock.calls[1][0])
    expect(titles.text).toContain("COALESCE(nc.file_type, 'markdown') IN (")
    expect(titles.params).toContain('markdown')
  })

  it('forwards quick-search note file types into the note query', () => {
    indexDb.allQueue.push(noteRows(5), journalRows(5))
    dataDb.allQueue.push(taskRows(5), inboxRows(5))

    quickSearch(indexDb, dataDb, { text: 'invoice', noteFileTypes: ['markdown'] })

    expect(sqlParts(indexDb.all.mock.calls[0][0]).params).toContain('markdown')
  })

  it('leaves note results unfiltered when no file types are requested', () => {
    indexDb.allQueue.push(noteRows(5))

    searchAll(indexDb, dataDb, query({ types: ['note'] }))

    expect(sqlParts(indexDb.all.mock.calls[0][0]).text).not.toContain('COALESCE')
  })

  it('continues after per-type FTS failures and keeps exact results if fuzzy fallback fails', () => {
    indexDb.allQueue.push(new Error('fts notes failed'))
    dataDb.allQueue.push(taskRows(1), new Error('title load failed'))

    const response = searchAll(indexDb, dataDb, query({ types: ['note', 'task'] }))

    expect(response.groups).toEqual([
      expect.objectContaining({
        type: 'task',
        results: [expect.objectContaining({ id: 'task-1' })],
        totalInGroup: 1
      })
    ])
    expect(loggerWarnMock).toHaveBeenCalledWith('Search failed for type note:', expect.any(Error))
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Fuzzy fallback failed for type task:',
      expect.any(Error)
    )
  })

  it('flattens quick search results and returns DB-backed stats with null-count fallback', () => {
    indexDb.allQueue.push(noteRows(3), journalRows(3))
    dataDb.allQueue.push(taskRows(3), inboxRows(3))

    const quick = quickSearch(indexDb, dataDb, { text: 'budget' })

    expect(quick.results).toHaveLength(12)
    expect(quick.results[0].id).toBe('note-1')

    indexDb.getQueue.push({ count: 5 }, undefined)
    dataDb.getQueue.push({ count: 7 }, { count: 2 })

    expect(getSearchStats(indexDb, dataDb)).toEqual({
      totalNotes: 5,
      totalJournals: 0,
      totalTasks: 7,
      totalInboxItems: 2,
      totalIndexed: 14,
      lastIndexedAt: null
    })
  })
})
