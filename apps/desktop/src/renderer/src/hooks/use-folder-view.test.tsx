import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type React from 'react'
import { toast } from 'sonner'
import { flushAllPendingSaves } from '@/lib/save-registry'
import { useFolderView } from './use-folder-view'

const mocks = vi.hoisted(() => ({
  evaluateFilter: vi.fn(),
  propertiesSet: vi.fn(),
  notesUpdate: vi.fn()
}))

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
  }
}))

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
    const { result } = renderHook(() => useFolderView({ folderPath: 'Work', pageSize: 2 }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(window.api.folderView.folderExists).toHaveBeenCalledWith('Work')
    expect(window.api.folderView.listWithProperties).toHaveBeenCalledWith({
      folderPath: 'Work',
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
      folderPath: 'Work',
      properties: undefined,
      limit: 2,
      offset: 2
    })
  })

  it('optimistically updates views, summaries, formulas, note properties, and tags', async () => {
    const { result } = renderHook(() => useFolderView({ folderPath: 'Work' }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.updateColumns([{ id: 'title' }, { id: 'wordCount', width: 160 }])
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    expect(window.api.folderView.setView).toHaveBeenCalledWith(
      'Work',
      expect.objectContaining({
        name: 'Main',
        columns: [{ id: 'title' }, { id: 'wordCount', width: 160 }]
      })
    )

    await act(async () => {
      await result.current.setViewAsDefault(1)
    })
    expect(window.api.folderView.setView).toHaveBeenCalledWith(
      'Work',
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

    const { result } = renderHook(() => useFolderView({ folderPath: 'Work' }), {
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
    const { result } = renderHook(() => useFolderView({ folderPath: 'Work' }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.addView({ name: 'Added', type: 'table', columns: [{ id: 'title' }] })
      await result.current.deleteView('Second')
      await result.current.setViewAsDefault(99)
    })

    expect(window.api.folderView.setView).toHaveBeenCalledWith(
      'Work',
      expect.objectContaining({ name: 'Added' })
    )
    expect(window.api.folderView.deleteView).toHaveBeenCalledWith('Work', 'Second')
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
    const { result } = renderHook(() => useFolderView({ folderPath: 'Work' }), {
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
    const { result } = renderHook(() => useFolderView({ folderPath: 'Work' }), {
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

    const { result } = renderHook(() => useFolderView({ folderPath: 'Missing' }), {
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

  it('flushes a pending column write when the hook unmounts before the debounce fires', async () => {
    const { result, unmount } = renderHook(() => useFolderView({ folderPath: 'Work' }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.updateColumns([{ id: 'status' }, { id: 'title' }])
    })

    // Still inside the debounce window: nothing written yet.
    expect(window.api.folderView.setView).not.toHaveBeenCalled()

    // User closes the tab / switches folder before the 300ms elapses.
    unmount()
    await act(async () => {
      await Promise.resolve()
    })

    expect(window.api.folderView.setView).toHaveBeenCalledWith(
      'Work',
      expect.objectContaining({ columns: [{ id: 'status' }, { id: 'title' }] })
    )
  })

  it('flushes a pending column write through the save registry on app quit', async () => {
    const { result } = renderHook(() => useFolderView({ folderPath: 'Work' }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.updateColumns([{ id: 'status' }, { id: 'title' }])
    })

    expect(window.api.folderView.setView).not.toHaveBeenCalled()

    // Main drains the registry and awaits it BEFORE closeVault(); a beforeunload
    // listener would instead run after the vault is closed and the write would fail.
    await act(async () => {
      await flushAllPendingSaves()
    })

    expect(window.api.folderView.setView).toHaveBeenCalledWith(
      'Work',
      expect.objectContaining({ columns: [{ id: 'status' }, { id: 'title' }] })
    )
  })

  it('flushes a pending column write when the user switches folders', async () => {
    const { result, rerender } = renderHook(
      ({ folderPath }: { folderPath: string }) => useFolderView({ folderPath }),
      { wrapper: makeWrapper(), initialProps: { folderPath: 'Work' } }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.updateColumns([{ id: 'status' }, { id: 'title' }])
    })

    expect(window.api.folderView.setView).not.toHaveBeenCalled()

    // The page swaps folderPath without remounting, so the switch must still
    // land Work's pending edit before Personal takes over the write slot.
    rerender({ folderPath: 'Personal' })
    await act(async () => {
      await Promise.resolve()
    })

    expect(window.api.folderView.setView).toHaveBeenCalledWith(
      'Work',
      expect.objectContaining({ columns: [{ id: 'status' }, { id: 'title' }] })
    )
  })

  it('serializes the view and rename writes so neither clobbers the other', async () => {
    let releaseSetView: (() => void) | undefined
    const setViewGate = new Promise<void>((resolve) => {
      releaseSetView = resolve
    })
    ;(window.api.folderView.setView as any).mockImplementationOnce(async () => {
      await setViewGate
      return { success: true }
    })

    const { result, unmount } = renderHook(() => useFolderView({ folderPath: 'Work' }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.updateColumns([{ id: 'status' }, { id: 'title' }])
      await result.current.renameView(0, 'Renamed')
    })

    unmount()
    await act(async () => {
      await Promise.resolve()
    })

    // Both handlers read-modify-write the same .folder.md. The rename must not
    // start until the view write has finished, or one silently erases the other.
    expect(window.api.folderView.setConfig).not.toHaveBeenCalled()

    await act(async () => {
      releaseSetView?.()
      await Promise.resolve()
    })

    await waitFor(() => expect(window.api.folderView.setConfig).toHaveBeenCalled())
  })

  it('keeps column edits and display-name edits in separate write slots', async () => {
    const { result, unmount } = renderHook(() => useFolderView({ folderPath: 'Work' }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.updateColumns([{ id: 'status' }, { id: 'title' }])
      await result.current.updateDisplayName('status', 'State')
    })

    unmount()
    await act(async () => {
      await Promise.resolve()
    })

    // A display-name edit must not evict the pending column edit.
    expect(window.api.folderView.setView).toHaveBeenCalledWith(
      'Work',
      expect.objectContaining({ columns: [{ id: 'status' }, { id: 'title' }] })
    )
  })

  it('reverts a display-name edit when the write fails', async () => {
    // withErrorHandler RESOLVES {success:false} on throw; it does not reject.
    ;(window.api.folderView.setView as any).mockResolvedValueOnce({
      success: false,
      error: 'No vault is currently open'
    })

    const { result } = renderHook(() => useFolderView({ folderPath: 'Work' }), {
      wrapper: makeWrapper()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.updateDisplayName('status', 'State')
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    // The failed setView must stop the sequence, not fall through to setConfig.
    await waitFor(() => expect(window.api.folderView.setConfig).not.toHaveBeenCalled())
  })
})
