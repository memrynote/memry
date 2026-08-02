import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type React from 'react'
import { toast } from 'sonner'
import { useFolderView, folderViewKeys } from './use-folder-view'
import type { ViewScope } from '@memry/contracts/folder-view-api'

const workScope: ViewScope = { kind: 'folder', path: 'Work' }
const missingScope: ViewScope = { kind: 'folder', path: 'Missing' }

const mocks = vi.hoisted(() => {
  const tagNotesChangedCallbacks: Array<(event: { tag: string }) => void> = []
  const tagsChangedCallbacks: Array<() => void> = []
  return {
    evaluateFilter: vi.fn(),
    propertiesSet: vi.fn(),
    notesUpdate: vi.fn(),
    tagNotesChangedCallbacks,
    tagsChangedCallbacks,
    onTagNotesChanged: vi.fn((callback: (event: { tag: string }) => void) => {
      tagNotesChangedCallbacks.push(callback)
      return () => {
        const index = tagNotesChangedCallbacks.indexOf(callback)
        if (index >= 0) tagNotesChangedCallbacks.splice(index, 1)
      }
    }),
    onTagsChanged: vi.fn((callback: () => void) => {
      tagsChangedCallbacks.push(callback)
      return () => {
        const index = tagsChangedCallbacks.indexOf(callback)
        if (index >= 0) tagsChangedCallbacks.splice(index, 1)
      }
    })
  }
})

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('@/lib/filter-evaluator', () => ({
  evaluateFilter: mocks.evaluateFilter
}))

vi.mock('@/services/properties-service', () => ({
  propertiesService: {
    set: mocks.propertiesSet
  }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    update: mocks.notesUpdate
  },
  onTagsChanged: mocks.onTagsChanged
}))

vi.mock('@/services/tags-service', () => ({
  onTagNotesChanged: mocks.onTagNotesChanged
}))

function emitTagNotesChanged(event: { tag: string }): void {
  for (const callback of [...mocks.tagNotesChangedCallbacks]) callback(event)
}

function emitTagsChanged(): void {
  for (const callback of [...mocks.tagsChangedCallbacks]) callback()
}

const firstPage = [
  {
    id: 'n1',
    path: 'notes/Work/alpha.md',
    title: 'Alpha',
    emoji: null,
    folder: 'Work',
    tags: ['old'],
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-02T00:00:00.000Z',
    wordCount: 100,
    properties: { status: 'draft' }
  },
  {
    id: 'n2',
    path: 'notes/Work/beta.md',
    title: 'Beta',
    emoji: null,
    folder: 'Work',
    tags: [],
    created: '2026-01-03T00:00:00.000Z',
    modified: '2026-01-04T00:00:00.000Z',
    wordCount: 10,
    properties: { status: 'done' }
  }
]

const secondPage = [
  {
    id: 'n3',
    path: 'notes/Work/gamma.md',
    title: 'Gamma',
    emoji: null,
    folder: 'Work',
    tags: [],
    created: '2026-01-05T00:00:00.000Z',
    modified: '2026-01-06T00:00:00.000Z',
    wordCount: 1,
    properties: {}
  }
]

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  })

  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

function folderApi(overrides: Partial<typeof window.api.folderView> = {}) {
  return {
    folderExists: vi.fn().mockResolvedValue(true),
    getViews: vi.fn().mockResolvedValue({
      defaultIndex: 0,
      views: [
        {
          name: 'Main',
          type: 'table',
          default: true,
          columns: [{ id: 'title' }, { id: 'status' }],
          filters: { op: 'equals', property: 'status', value: 'draft' },
          showSummaries: false
        },
        {
          name: 'Second',
          type: 'table',
          columns: [{ id: 'title' }]
        }
      ]
    }),
    getConfig: vi.fn().mockResolvedValue({
      config: {
        summaries: { title: { type: 'count' } },
        properties: { title: { displayName: 'Title' } },
        formulas: { Score: 'wordCount * 2' }
      }
    }),
    getAvailableProperties: vi.fn().mockResolvedValue({
      properties: [{ name: 'status', type: 'text', usageCount: 2 }],
      builtIn: [{ id: 'title', displayName: 'Title', type: 'text' }],
      formulas: [{ id: 'Score', expression: 'wordCount * 2' }]
    }),
    listWithProperties: vi.fn().mockImplementation(({ offset }) =>
      Promise.resolve({
        notes: offset === 0 ? firstPage : secondPage,
        hasMore: offset === 0,
        total: 3
      })
    ),
    setView: vi.fn().mockResolvedValue({ success: true }),
    deleteView: vi.fn().mockResolvedValue({ success: true }),
    setConfig: vi.fn().mockResolvedValue({ success: true }),
    ...overrides
  }
}

describe('useFolderView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.tagNotesChangedCallbacks.length = 0
    mocks.tagsChangedCallbacks.length = 0
    mocks.evaluateFilter.mockImplementation((note: { id: string }) => note.id === 'n1')
    mocks.propertiesSet.mockResolvedValue({ success: true })
    mocks.notesUpdate.mockResolvedValue({ success: true })
    vi.stubGlobal('window', {
      ...window,
      api: {
        ...(window as any).api,
        folderView: folderApi()
      }
    })
  })

  it('loads folder metadata, filters notes, paginates, and exposes formulas', async () => {
    const { result } = renderHook(() => useFolderView({ scope: workScope, pageSize: 2 }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(window.api.folderView.folderExists).toHaveBeenCalledWith('Work')
    expect(window.api.folderView.listWithProperties).toHaveBeenCalledWith({
      scope: workScope,
      properties: undefined,
      limit: 2,
      offset: 0
    })
    expect(result.current.views.map((view) => view.name)).toEqual(['Main', 'Second'])
    expect(result.current.activeView?.name).toBe('Main')
    expect(result.current.notes).toEqual([firstPage[0]])
    expect(result.current.totalNotes).toBe(1)
    expect(result.current.unfilteredCount).toBe(2)
    expect(result.current.hasMore).toBe(true)
    expect(result.current.availableProperties).toEqual([
      { name: 'status', type: 'text', usageCount: 2 }
    ])
    expect(result.current.builtInColumns).toEqual([
      { id: 'title', displayName: 'Title', type: 'text' }
    ])
    expect(result.current.formulasMap).toEqual({ Score: 'wordCount * 2' })
    expect(result.current.summaries).toEqual({ title: { type: 'count' } })

    await act(async () => {
      await result.current.loadMore()
    })

    await waitFor(() => expect(window.api.folderView.listWithProperties).toHaveBeenCalledTimes(2))
    expect(window.api.folderView.listWithProperties).toHaveBeenLastCalledWith({
      scope: workScope,
      properties: undefined,
      limit: 2,
      offset: 2
    })
  })

  it('optimistically updates views, summaries, formulas, note properties, and tags', async () => {
    const { result } = renderHook(() => useFolderView({ scope: workScope }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.updateColumns([{ id: 'title' }, { id: 'wordCount', width: 160 }])
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    expect(window.api.folderView.setView).toHaveBeenCalledWith(
      workScope,
      expect.objectContaining({
        name: 'Main',
        columns: [{ id: 'title' }, { id: 'wordCount', width: 160 }]
      })
    )

    await act(async () => {
      await result.current.setViewAsDefault(1)
    })
    expect(window.api.folderView.setView).toHaveBeenCalledWith(
      workScope,
      expect.objectContaining({ name: 'Second', default: true })
    )

    await act(async () => {
      await result.current.updateSummaryConfig('wordCount', { type: 'sum' })
    })
    expect(window.api.folderView.setConfig).toHaveBeenCalledWith(
      'Work',
      expect.objectContaining({
        summaries: expect.objectContaining({ wordCount: { type: 'sum' } })
      })
    )

    await act(async () => {
      await result.current.addFormula('Reading', 'wordCount / 200')
      await result.current.updateFormula('Reading', 'wordCount / 250')
      await result.current.deleteFormula('Score')
    })
    expect(window.api.folderView.setConfig).toHaveBeenCalledWith(
      'Work',
      expect.objectContaining({
        formulas: expect.objectContaining({ Reading: 'wordCount / 200' })
      })
    )
    expect(window.api.folderView.setConfig).toHaveBeenCalledWith(
      'Work',
      expect.objectContaining({
        formulas: expect.objectContaining({ Reading: 'wordCount / 250' })
      })
    )

    await act(async () => {
      await result.current.updateNoteProperty('n1', 'status', 'review')
      await result.current.updateNoteTags('n1', ['new'])
      result.current.removeNotesOptimistically(['n2'])
      await result.current.refresh()
    })

    expect(mocks.propertiesSet).toHaveBeenCalledWith('n1', { status: 'review' })
    expect(mocks.notesUpdate).toHaveBeenCalledWith({ id: 'n1', tags: ['new'] })
    expect(window.api.folderView.getViews).toHaveBeenCalled()
  })

  it('covers filter errors, debounced view writes, and display-name rollback', async () => {
    mocks.evaluateFilter.mockImplementation(() => {
      throw new Error('bad filter')
    })
    ;(window.api.folderView.setView as any).mockResolvedValueOnce({
      success: false,
      error: 'cannot save'
    })

    const { result } = renderHook(() => useFolderView({ scope: workScope }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.notes).toEqual(firstPage)

    await act(async () => {
      await result.current.updateView({ limit: undefined })
      await result.current.updateSorting([{ property: 'modified', direction: 'desc' }])
      await result.current.updateFilters(undefined)
      await result.current.toggleShowSummaries()
      await result.current.updateGroupBy({ property: 'status', direction: 'asc' } as any)
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    await waitFor(() => expect(window.api.folderView.setView).toHaveBeenCalled())

    await act(async () => {
      await result.current.updateDisplayName('status', 'Status')
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })
    expect(window.api.folderView.setConfig).toHaveBeenCalledWith(
      'Work',
      expect.objectContaining({
        properties: expect.objectContaining({
          status: expect.objectContaining({ displayName: 'Status' })
        })
      })
    )
    ;(window.api.folderView.setView as any).mockRejectedValueOnce(new Error('display failed'))
    await act(async () => {
      await result.current.updateDisplayName('status', 'State')
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })
  })

  it('covers view-management success and failure branches', async () => {
    const { result } = renderHook(() => useFolderView({ scope: workScope }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.addView({ name: 'Added', type: 'table', columns: [{ id: 'title' }] })
      await result.current.deleteView('Second')
      await result.current.setViewAsDefault(99)
    })

    expect(window.api.folderView.setView).toHaveBeenCalledWith(
      workScope,
      expect.objectContaining({ name: 'Added' })
    )
    expect(window.api.folderView.deleteView).toHaveBeenCalledWith(workScope, 'Second')
    ;(window.api.folderView.setView as any).mockResolvedValueOnce({
      success: false,
      error: 'add failed'
    })
    await expect(
      result.current.addView({ name: 'Broken', type: 'table', columns: [{ id: 'title' }] })
    ).rejects.toThrow('add failed')
    ;(window.api.folderView.deleteView as any).mockResolvedValueOnce({
      success: false,
      error: 'delete failed'
    })
    await expect(result.current.deleteView('Broken')).rejects.toThrow('delete failed')
    ;(window.api.folderView.setView as any).mockResolvedValueOnce({
      success: false,
      error: 'default failed'
    })
    await expect(result.current.setViewAsDefault(0)).rejects.toThrow('default failed')
  })

  it('renames a view in place via setConfig without going through setView', async () => {
    const { result } = renderHook(() => useFolderView({ scope: workScope }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.renameView(1, 'Renamed')
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    // Whole array rewritten with order preserved — no name-keyed duplicate.
    expect(window.api.folderView.setConfig).toHaveBeenCalledWith(
      'Work',
      expect.objectContaining({
        views: [
          expect.objectContaining({ name: 'Main' }),
          expect.objectContaining({ name: 'Renamed' })
        ]
      })
    )
    expect(window.api.folderView.setView).not.toHaveBeenCalled()

    // Empty names and names that collide with another view are a no-op.
    const calls = (window.api.folderView.setConfig as any).mock.calls.length
    await act(async () => {
      await result.current.renameView(0, '   ')
      await result.current.renameView(1, 'Main')
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })
    expect((window.api.folderView.setConfig as any).mock.calls.length).toBe(calls)
  })

  it('covers summary delete, note-property deletion, missing cache, and formula failures', async () => {
    const { result } = renderHook(() => useFolderView({ scope: workScope }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.updateSummaryConfig('title', undefined)
      await result.current.updateNoteProperty('n1', 'status', undefined)
      await result.current.updateNoteProperty('missing', 'status', 'new')
    })

    expect(mocks.propertiesSet).toHaveBeenCalledWith('n1', {})
    expect(mocks.propertiesSet).toHaveBeenCalledWith('missing', { status: 'new' })

    mocks.notesUpdate.mockResolvedValueOnce({ success: false, error: 'No tags' })
    await act(async () => {
      await result.current.updateNoteTags('n1', ['bad'])
    })
    expect(toast.error).toHaveBeenCalledWith('phaseI.toasts.failedToUpdateTags')
    ;(window.api.folderView.getConfig as any).mockRejectedValueOnce(new Error('summary failed'))
    await act(async () => {
      await result.current.updateSummaryConfig('title', { type: 'count' })
    })
    ;(window.api.folderView.setConfig as any).mockRejectedValueOnce(new Error('formula failed'))
    await expect(result.current.addFormula('Broken', '1 + 1')).rejects.toThrow('formula failed')
    ;(window.api.folderView.setConfig as any).mockRejectedValueOnce(new Error('formula failed'))
    await expect(result.current.updateFormula('Score', '1 + 2')).rejects.toThrow('formula failed')
    ;(window.api.folderView.setConfig as any).mockRejectedValueOnce(new Error('formula failed'))
    await expect(result.current.deleteFormula('Score')).rejects.toThrow('formula failed')
  })

  it('surfaces not-found and rolls back failed note edits', async () => {
    ;(window.api.folderView as any) = folderApi({
      folderExists: vi.fn().mockResolvedValue(false)
    })
    mocks.propertiesSet.mockResolvedValueOnce({ success: false, error: 'No write' })
    mocks.notesUpdate.mockRejectedValueOnce(new Error('No tags'))

    const { result } = renderHook(() => useFolderView({ scope: missingScope }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.folderNotFound).toBe(true)

    await act(async () => {
      await result.current.updateNoteProperty('n1', 'status', 'review')
      await result.current.updateNoteTags('n1', ['broken'])
    })

    expect(toast.error).toHaveBeenCalledWith('phaseI.toasts.failedToUpdateProperty')
    expect(toast.error).toHaveBeenCalledWith('phaseI.toasts.failedToUpdateTags')
  })

  it('keys caches by scope so a folder and a same-named tag never collide', () => {
    expect(folderViewKeys.notes({ kind: 'folder', path: 'araba' })).not.toEqual(
      folderViewKeys.notes({ kind: 'tag', tag: 'araba' })
    )
  })

  it('requests tag-scoped rows through the folder view channel', async () => {
    renderHook(() => useFolderView({ scope: { kind: 'tag', tag: 'araba' } }), {
      wrapper: makeWrapper()
    })

    await waitFor(() =>
      expect(window.api.folderView.listWithProperties).toHaveBeenCalledWith(
        expect.objectContaining({ scope: { kind: 'tag', tag: 'araba' } })
      )
    )
  })

  it('never calls folderExists for a tag scope', async () => {
    renderHook(() => useFolderView({ scope: { kind: 'tag', tag: 'araba' } }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(window.api.folderView.listWithProperties).toHaveBeenCalled())
    expect(window.api.folderView.folderExists).not.toHaveBeenCalled()
  })

  it('refetches when a note gains or loses this tag', async () => {
    const { result } = renderHook(() => useFolderView({ scope: { kind: 'tag', tag: 'araba' } }), {
      wrapper: makeWrapper()
    })
    // Wait for the initial fetch to fully settle, not just for the mock to
    // have been invoked — invalidating a still-in-flight query is a no-op,
    // it just rides along with the fetch already underway.
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(window.api.folderView.listWithProperties).toHaveBeenCalledTimes(1)

    act(() => emitTagNotesChanged({ tag: 'araba' }))

    await waitFor(() => expect(window.api.folderView.listWithProperties).toHaveBeenCalledTimes(2))
  })

  it('ignores a change to a different tag', async () => {
    const { result } = renderHook(() => useFolderView({ scope: { kind: 'tag', tag: 'araba' } }), {
      wrapper: makeWrapper()
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(window.api.folderView.listWithProperties).toHaveBeenCalledTimes(1)

    act(() => emitTagNotesChanged({ tag: 'bisiklet' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(window.api.folderView.listWithProperties).toHaveBeenCalledTimes(1)
  })

  it('refetches on the untargeted tags-changed signal', async () => {
    const { result } = renderHook(() => useFolderView({ scope: { kind: 'tag', tag: 'araba' } }), {
      wrapper: makeWrapper()
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(window.api.folderView.listWithProperties).toHaveBeenCalledTimes(1)

    act(() => emitTagsChanged())

    await waitFor(() => expect(window.api.folderView.listWithProperties).toHaveBeenCalledTimes(2))
  })

  it('does not subscribe to tag events under folder scope', async () => {
    renderHook(() => useFolderView({ scope: workScope }), {
      wrapper: makeWrapper()
    })
    await waitFor(() => expect(window.api.folderView.listWithProperties).toHaveBeenCalled())

    expect(mocks.onTagNotesChanged).not.toHaveBeenCalled()
  })
})
