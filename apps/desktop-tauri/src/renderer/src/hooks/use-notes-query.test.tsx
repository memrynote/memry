import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_QUERY_DEFAULT_OPTIONS } from '@/lib/query-client-options'
import {
  notesKeys,
  useNote,
  useNoteFoldersQuery,
  useNoteLinksQuery,
  useNoteMutations,
  useNotesList,
  useNoteTagsQuery
} from './use-notes-query'
import type { Note, NoteListItem, NoteListResponse } from '@memry/rpc/notes'

type NoteEvent = { id: string; changes?: { content?: unknown } }
type EmptyHandler = () => void
type MovedHandler = (event?: { id: string; oldPath: string; newPath: string }) => void
type NoteHandler = (event: NoteEvent) => void

const mocks = vi.hoisted(() => ({
  notesService: {
    get: vi.fn(),
    list: vi.fn(),
    getFolders: vi.fn(),
    createFolder: vi.fn(),
    getFolderConfig: vi.fn(),
    setFolderConfig: vi.fn(),
    getLinks: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    rename: vi.fn(),
    move: vi.fn()
  },
  tagsService: {
    getAllWithCounts: vi.fn()
  },
  handlers: {
    created: [] as EmptyHandler[],
    updated: [] as NoteHandler[],
    deleted: [] as NoteHandler[],
    renamed: [] as NoteHandler[],
    moved: [] as MovedHandler[],
    linksChanged: [] as ((event: { sourceIds: string[]; targetIds: string[] }) => void)[],
    external: [] as NoteHandler[],
    dropped: [] as EmptyHandler[],
    indexProgress: [] as ((progress: number) => void)[],
    journal: [] as EmptyHandler[],
    canvas: [] as EmptyHandler[]
  }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: mocks.notesService,
  onNoteCreated: (callback: EmptyHandler) => {
    mocks.handlers.created.push(callback)
    return vi.fn()
  },
  onNoteUpdated: (callback: NoteHandler) => {
    mocks.handlers.updated.push(callback)
    return vi.fn()
  },
  onNoteDeleted: (callback: NoteHandler) => {
    mocks.handlers.deleted.push(callback)
    return vi.fn()
  },
  onNoteRenamed: (callback: NoteHandler) => {
    mocks.handlers.renamed.push(callback)
    return vi.fn()
  },
  onNoteMoved: (callback: MovedHandler) => {
    mocks.handlers.moved.push(callback)
    return vi.fn()
  },
  onNoteLinksChanged: (callback: (event: { sourceIds: string[]; targetIds: string[] }) => void) => {
    mocks.handlers.linksChanged.push(callback)
    return vi.fn()
  },
  onNoteExternalChange: (callback: NoteHandler) => {
    mocks.handlers.external.push(callback)
    return vi.fn()
  },
  onNoteEventsDropped: (callback: EmptyHandler) => {
    mocks.handlers.dropped.push(callback)
    return vi.fn()
  }
}))

vi.mock('@/services/tags-service', () => ({
  tagsService: mocks.tagsService
}))

vi.mock('@/services/canvas-service', () => {
  const subscribe = (callback: EmptyHandler) => {
    mocks.handlers.canvas.push(callback)
    return vi.fn()
  }
  return { onCanvasCreated: subscribe, onCanvasUpdated: subscribe, onCanvasDeleted: subscribe }
})

vi.mock('@/services/journal-service', () => {
  const subscribe = (callback: EmptyHandler) => {
    mocks.handlers.journal.push(callback)
    return vi.fn()
  }
  return {
    onJournalEntryCreated: subscribe,
    onJournalEntryUpdated: subscribe,
    onJournalEntryDeleted: subscribe
  }
})

vi.mock('@/services/vault-service', () => ({
  onVaultIndexProgress: (callback: (progress: number) => void) => {
    mocks.handlers.indexProgress.push(callback)
    return vi.fn()
  }
}))

const note = (id: string, title: string): Note =>
  ({
    id,
    title,
    path: `notes/${title}.md`,
    content: `# ${title}`,
    tags: [],
    properties: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }) as Note

const listItem = (id: string, title: string): NoteListItem =>
  ({
    id,
    title,
    path: `notes/${title}.md`,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }) as NoteListItem

describe('use-notes-query', () => {
  let queryClient: QueryClient

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  beforeEach(() => {
    vi.clearAllMocks()
    for (const handlers of Object.values(mocks.handlers)) handlers.length = 0
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false, gcTime: Infinity },
        mutations: { retry: false }
      }
    })

    mocks.notesService.get.mockResolvedValue(note('n1', 'First'))
    mocks.notesService.list.mockResolvedValue({
      notes: [listItem('n1', 'First')],
      total: 1,
      hasMore: false
    } satisfies NoteListResponse)
    mocks.notesService.getFolders.mockResolvedValue([{ path: 'Work', name: 'Work', count: 1 }])
    mocks.notesService.createFolder.mockResolvedValue({ success: true })
    mocks.notesService.getFolderConfig.mockResolvedValue({ sortBy: 'title' })
    mocks.notesService.setFolderConfig.mockResolvedValue({ success: true })
    mocks.notesService.getLinks.mockResolvedValue({
      outgoing: [{ id: 'n2', title: 'Second' }],
      incoming: []
    })
    mocks.notesService.create.mockResolvedValue({ success: true, note: note('n2', 'Second') })
    mocks.notesService.update.mockResolvedValue({ success: true, note: note('n1', 'Updated') })
    mocks.notesService.delete.mockResolvedValue({ success: true })
    mocks.notesService.rename.mockResolvedValue({ success: true, note: note('n1', 'Renamed') })
    mocks.notesService.move.mockResolvedValue({ success: true, note: note('n1', 'Moved') })
    mocks.tagsService.getAllWithCounts.mockResolvedValue({
      tags: [{ name: 'work', color: '#ff0000', count: 2 }]
    })
  })

  it('fetches a single note and refreshes it from note events', async () => {
    const { result } = renderHook(() => useNote('n1'), { wrapper })

    await waitFor(() => expect(result.current.note?.title).toBe('First'))

    mocks.notesService.get.mockResolvedValueOnce(note('n1', 'Refreshed'))
    await act(async () => {
      mocks.handlers.updated[0]({ id: 'n1', changes: { content: 'changed' } })
    })

    await waitFor(() => expect(result.current.note?.title).toBe('Refreshed'))

    await act(async () => {
      mocks.handlers.deleted[0]({ id: 'n1' })
    })
    expect(queryClient.getQueryData(notesKeys.note('n1'))).toBeUndefined()
  })

  // #4146: the note is a local read. With TanStack's default network mode the WebView's `offline`
  // event paused it, and the page showed no note and no spinner.
  describe('while the WebView reports offline', () => {
    afterEach(() => onlineManager.setOnline(true))

    it('still reads the note with the app query defaults', async () => {
      queryClient = new QueryClient({ defaultOptions: APP_QUERY_DEFAULT_OPTIONS })
      onlineManager.setOnline(false)

      const { result } = renderHook(() => useNote('n1'), { wrapper })

      await waitFor(() => expect(result.current.note?.title).toBe('First'))
      expect(mocks.notesService.get).toHaveBeenCalledWith('n1')
    })

    it('still writes a note update with the app mutation defaults', async () => {
      queryClient = new QueryClient({ defaultOptions: APP_QUERY_DEFAULT_OPTIONS })
      onlineManager.setOnline(false)

      const { result } = renderHook(() => useNoteMutations(), { wrapper })
      await act(async () => {
        await result.current.updateNote.mutateAsync({ id: 'n1', tags: ['offline'] })
      })

      expect(mocks.notesService.update.mock.calls[0][0]).toEqual({ id: 'n1', tags: ['offline'] })
    })
  })

  // A page opened again from a fresh cache, or switched to a cached note, reads the file again:
  // an outside edit made while no page had the note open sends it no event (#3967).
  it('reads a cached note again on mount and on a switch to it, when asked to', async () => {
    queryClient.setQueryData(notesKeys.note('n1'), note('n1', 'Cached'))
    queryClient.setQueryData(notesKeys.note('n2'), note('n2', 'Cached'))
    mocks.notesService.get.mockImplementation(async (id: string) => note(id, 'On disk'))
    const { result, rerender } = renderHook(({ id, readOnMount }) => useNote(id, { readOnMount }), {
      wrapper,
      initialProps: { id: 'n1', readOnMount: true }
    })
    expect(result.current.note?.title).toBe('Cached')
    await waitFor(() => expect(result.current.note?.title).toBe('On disk'))
    expect(result.current.isFetchedAfterMount).toBe(true)

    rerender({ id: 'n2', readOnMount: true })
    expect(result.current.isFetchedAfterMount).toBe(false)
    await waitFor(() => expect(result.current.note?.title).toBe('On disk'))

    // Other readers keep the cache's freshness.
    queryClient.setQueryData(notesKeys.note('n3'), note('n3', 'Cached'))
    rerender({ id: 'n3', readOnMount: false })
    expect(mocks.notesService.get).not.toHaveBeenCalledWith('n3')
  })

  it('#3958: the open note takes its new path when it moves, and ignores other notes moving', async () => {
    const { result } = renderHook(() => useNote('n1'), { wrapper })
    await waitFor(() => expect(result.current.note?.path).toBe('notes/First.md'))

    // What the folder rename leaves on disk: the read answers the new path.
    mocks.notesService.get.mockResolvedValue({ ...note('n1', 'First'), path: 'Archive/First.md' })
    const move = (id: string, oldPath: string, newPath: string) =>
      act(async () => {
        for (const handler of mocks.handlers.moved) handler({ id, oldPath, newPath })
      })

    const reads = mocks.notesService.get.mock.calls.length
    await move('n2', 'notes/Other.md', 'Archive/Other.md')
    expect(result.current.note?.path).toBe('notes/First.md')

    await move('n1', 'notes/First.md', 'Archive/First.md')
    await waitFor(() => expect(result.current.note?.path).toBe('Archive/First.md'))
    // The move patches the cached note: the editor's text is not read again.
    expect(mocks.notesService.get).toHaveBeenCalledTimes(reads)
  })

  it('#3981: a read in flight when the note moves does not bring the old path back', async () => {
    const { result } = renderHook(() => useNote('n1'), { wrapper })
    await waitFor(() => expect(result.current.note?.path).toBe('notes/First.md'))

    // An edit's refetch is reading the note when the folder rename lands.
    let answerStale: (value: Note) => void = () => {}
    mocks.notesService.get.mockImplementationOnce(
      () => new Promise<Note>((resolve) => (answerStale = resolve))
    )
    mocks.notesService.get.mockResolvedValue({ ...note('n1', 'First'), path: 'Archive/First.md' })
    await act(async () => {
      mocks.handlers.updated[0]({ id: 'n1', changes: { content: 'changed' } })
    })
    await act(async () => {
      for (const handler of mocks.handlers.moved) {
        handler({ id: 'n1', oldPath: 'notes/First.md', newPath: 'Archive/First.md' })
      }
    })
    await act(async () => answerStale(note('n1', 'First')))

    await waitFor(() => expect(result.current.note?.path).toBe('Archive/First.md'))
    expect(result.current.isFetching).toBe(false)
  })

  it('#4295: a move while the first read is out reads the note again', async () => {
    // The first read began before the move and has no data to patch: its answer is the old path.
    let answerStale: (value: Note) => void = () => {}
    mocks.notesService.get.mockImplementationOnce(
      () => new Promise<Note>((resolve) => (answerStale = resolve))
    )
    mocks.notesService.get.mockResolvedValue({ ...note('n1', 'First'), path: 'Archive/First.md' })
    const { result } = renderHook(() => useNote('n1'), { wrapper })
    await waitFor(() => expect(mocks.handlers.moved.length).toBeGreaterThan(0))

    await act(async () => {
      for (const handler of mocks.handlers.moved) {
        handler({ id: 'n1', oldPath: 'notes/First.md', newPath: 'Archive/First.md' })
      }
    })
    await act(async () => answerStale(note('n1', 'First')))

    await waitFor(() => expect(result.current.note?.path).toBe('Archive/First.md'))
  })

  it('fetches note lists and invalidates them on create, rename, move, update, and delete events', async () => {
    const { result } = renderHook(() => useNotesList({ folder: 'Work' }), { wrapper })

    await waitFor(() => expect(result.current.notes[0]?.title).toBe('First'))
    expect(mocks.notesService.list).toHaveBeenCalledWith({ folder: 'Work' })

    mocks.notesService.list.mockResolvedValue({
      notes: [listItem('n2', 'Second')],
      total: 1,
      hasMore: false
    } satisfies NoteListResponse)

    await act(async () => {
      mocks.handlers.created[0]()
      mocks.handlers.updated[0]({ id: 'n2' })
      mocks.handlers.renamed[0]({ id: 'n2' })
      mocks.handlers.moved[0]()
      mocks.handlers.deleted[0]({ id: 'n2' })
    })

    await waitFor(() => expect(mocks.notesService.list).toHaveBeenCalledTimes(6))
    expect(result.current.notes[0]?.title).toBe('Second')
  })

  it('refetches a list that includes journal entries on journal events, and only that one', async () => {
    renderHook(() => useNotesList({ fields: 'tree' }), { wrapper })
    await waitFor(() => expect(mocks.notesService.list).toHaveBeenCalledTimes(1))
    // A list without journal entries does not listen to the Journal at all.
    expect(mocks.handlers.journal).toHaveLength(0)

    renderHook(() => useNotesList({ fields: 'tree', includeJournals: true }), { wrapper })
    await waitFor(() => expect(mocks.notesService.list).toHaveBeenCalledTimes(2))
    expect(mocks.notesService.list).toHaveBeenLastCalledWith({
      fields: 'tree',
      includeJournals: true
    })
    expect(mocks.handlers.journal).toHaveLength(3)

    await act(async () => {
      mocks.handlers.journal[0]()
    })
    await waitFor(() => expect(mocks.notesService.list).toHaveBeenCalledTimes(4))
  })

  it('refetches the lists, the tags and the open note when note events were dropped', async () => {
    const list = renderHook(() => useNotesList(), { wrapper })
    const open = renderHook(() => useNote('n1'), { wrapper })
    const tags = renderHook(() => useNoteTagsQuery(), { wrapper })
    await waitFor(() => expect(list.result.current.notes[0]?.title).toBe('First'))
    await waitFor(() => expect(open.result.current.note?.title).toBe('First'))
    await waitFor(() => expect(tags.result.current.tags).toHaveLength(1))
    expect(mocks.handlers.dropped).toHaveLength(2)

    mocks.notesService.list.mockResolvedValue({
      notes: [listItem('n2', 'Missed')],
      total: 1,
      hasMore: false
    } satisfies NoteListResponse)
    mocks.notesService.get.mockResolvedValue(note('n1', 'Edited outside'))
    await act(async () => {
      for (const dropped of mocks.handlers.dropped) dropped()
    })

    await waitFor(() => expect(list.result.current.notes[0]?.title).toBe('Missed'))
    await waitFor(() => expect(open.result.current.note?.title).toBe('Edited outside'))
    await waitFor(() => expect(mocks.tagsService.getAllWithCounts).toHaveBeenCalledTimes(2))
  })

  it('#1832: refetches lists on background index-build progress, throttled, always at completion', async () => {
    const { result } = renderHook(() => useNotesList(), { wrapper })

    await waitFor(() => expect(result.current.notes[0]?.title).toBe('First'))

    mocks.notesService.list.mockResolvedValue({
      notes: [listItem('n9', 'Indexed')],
      total: 1,
      hasMore: false
    } satisfies NoteListResponse)

    const beat = mocks.handlers.indexProgress[0]
    expect(beat).toBeDefined()

    // Progress beats arrive every 10 walked files â a burst inside the throttle
    // window collapses to a single refetch.
    await act(async () => {
      beat(10)
      beat(20)
      beat(30)
    })
    await waitFor(() => expect(mocks.notesService.list).toHaveBeenCalledTimes(2))

    // The completion beat always lands so the finished tree is fetched.
    await act(async () => {
      beat(100)
    })
    await waitFor(() => expect(mocks.notesService.list).toHaveBeenCalledTimes(3))
    expect(result.current.notes[0]?.title).toBe('Indexed')
  })

  it('loads tags, folders, folder mutations, and link queries with event invalidation', async () => {
    const tagsHook = renderHook(() => useNoteTagsQuery(), { wrapper })
    await waitFor(() =>
      expect(tagsHook.result.current.tags[0]).toEqual({
        tag: 'work',
        color: '#ff0000',
        count: 2,
        icon: null,
        categoryId: null,
        sortOrder: 0
      })
    )

    const foldersHook = renderHook(() => useNoteFoldersQuery(), { wrapper })
    await waitFor(() => expect(foldersHook.result.current.folders[0]?.name).toBe('Work'))

    await act(async () => {
      expect(await foldersHook.result.current.createFolder('Projects')).toBe(true)
      expect(await foldersHook.result.current.setFolderIcon('Work', 'icon:folder')).toBe(true)
    })
    expect(mocks.notesService.setFolderConfig).toHaveBeenCalledWith('Work', {
      sortBy: 'title',
      icon: 'icon:folder'
    })

    const linksHook = renderHook(() => useNoteLinksQuery('n1'), { wrapper })
    await waitFor(() => expect(linksHook.result.current.outgoing[0]?.title).toBe('Second'))

    mocks.notesService.getLinks.mockResolvedValueOnce({
      outgoing: [],
      incoming: [{ id: 'n3', title: 'Third' }]
    })
    await act(async () => {
      mocks.handlers.updated.find(Boolean)?.({ id: 'other', changes: { content: 'changed' } })
    })
    await waitFor(() => expect(linksHook.result.current.incoming[0]?.title).toBe('Third'))
  })

  it('refetches links when a note is created, so an unresolved outgoing link resolves', async () => {
    mocks.notesService.getLinks.mockResolvedValueOnce({
      outgoing: [{ sourceId: 'n1', targetId: null, targetTitle: 'Later' }],
      incoming: []
    })
    const { result } = renderHook(() => useNoteLinksQuery('n1'), { wrapper })
    await waitFor(() => expect(result.current.outgoing[0]?.targetId).toBeNull())

    mocks.notesService.getLinks.mockResolvedValueOnce({
      outgoing: [{ sourceId: 'n1', targetId: 'n9', targetTitle: 'Later' }],
      incoming: []
    })
    await act(async () => {
      mocks.handlers.created.forEach((handler) => handler())
    })

    await waitFor(() =>
      expect(result.current.outgoing).toEqual([
        { sourceId: 'n1', targetId: 'n9', targetTitle: 'Later' }
      ])
    )
  })

  it('refetches links when the index wrote links that touch the note, and only then', async () => {
    mocks.notesService.getLinks.mockResolvedValueOnce({ outgoing: [], incoming: [] })
    const { result } = renderHook(() => useNoteLinksQuery('n1'), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const calls = () => mocks.notesService.getLinks.mock.calls.length
    const before = calls()

    await act(async () => {
      mocks.handlers.linksChanged.forEach((handler) =>
        handler({ sourceIds: ['n7'], targetIds: ['n8'] })
      )
    })
    expect(calls()).toBe(before)

    const backlink = { sourceId: 'n7', sourcePath: 'Seven.md', sourceTitle: 'Seven', contexts: [] }
    mocks.notesService.getLinks.mockResolvedValueOnce({ outgoing: [], incoming: [backlink] })
    await act(async () => {
      mocks.handlers.linksChanged.forEach((handler) =>
        handler({ sourceIds: ['n7'], targetIds: ['n1'] })
      )
    })
    await waitFor(() => expect(result.current.incoming).toEqual([backlink]))

    mocks.notesService.getLinks.mockResolvedValueOnce({ outgoing: [], incoming: [] })
    await act(async () => {
      mocks.handlers.linksChanged.forEach((handler) =>
        handler({ sourceIds: ['n1'], targetIds: [] })
      )
    })
    await waitFor(() => expect(result.current.incoming).toEqual([]))
  })

  it('refetches links when a canvas changes, so a new arrow shows as a connection', async () => {
    mocks.notesService.getLinks.mockResolvedValueOnce({ outgoing: [], incoming: [] })
    const { result } = renderHook(() => useNoteLinksQuery('n1'), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // Subscription order: created, updated, deleted.
    expect(mocks.handlers.canvas).toHaveLength(3)
    const via = { kind: 'canvas' as const, canvasId: 'c1', canvasTitle: 'Map' }
    mocks.notesService.getLinks.mockResolvedValueOnce({
      outgoing: [{ sourceId: 'n1', targetId: 'n2', targetTitle: 'Two', via }],
      incoming: []
    })
    await act(async () => {
      mocks.handlers.canvas[1]()
    })

    await waitFor(() => expect(result.current.outgoing[0]?.via).toEqual(via))
  })

  it('exposes note mutations and updates the affected query caches', async () => {
    queryClient.setQueryData(notesKeys.note('n1'), note('n1', 'First'))
    const { result } = renderHook(() => useNoteMutations(), { wrapper })

    await act(async () => {
      await result.current.createNote.mutateAsync({ title: 'Second' })
      await result.current.updateNote.mutateAsync({ id: 'n1', title: 'Updated' })
      await result.current.renameNote.mutateAsync({ id: 'n1', newTitle: 'Renamed' })
      await result.current.moveNote.mutateAsync({ id: 'n1', newFolder: 'Archive' })
      await result.current.deleteNote.mutateAsync('n1')
    })

    expect(mocks.notesService.create.mock.calls[0][0]).toEqual({ title: 'Second' })
    expect(mocks.notesService.update.mock.calls[0][0]).toEqual({ id: 'n1', title: 'Updated' })
    expect(mocks.notesService.rename).toHaveBeenCalledWith('n1', 'Renamed')
    expect(mocks.notesService.move).toHaveBeenCalledWith('n1', 'Archive')
    expect(mocks.notesService.delete.mock.calls[0][0]).toBe('n1')
    expect(queryClient.getQueryData(notesKeys.note('n1'))).toBeUndefined()
  })

  it('rejects a refused rename with its reason, so the caller shows it (#4008)', async () => {
    queryClient.setQueryData(notesKeys.note('n1'), note('n1', 'First'))
    mocks.notesService.rename.mockResolvedValueOnce({
      success: false,
      error: 'A note title can be 1 to 200 characters long.',
      note: null
    })
    const { result } = renderHook(() => useNoteMutations(), { wrapper })

    await act(async () => {
      await expect(
        result.current.renameNote.mutateAsync({ id: 'n1', newTitle: 'x'.repeat(201) })
      ).rejects.toThrow('A note title can be 1 to 200 characters long.')
    })
    expect(queryClient.getQueryData(notesKeys.note('n1'))).toEqual(note('n1', 'First'))
  })

  it('keeps a note cached when its delete did not happen', async () => {
    queryClient.setQueryData(notesKeys.note('n1'), note('n1', 'First'))
    mocks.notesService.delete.mockResolvedValueOnce({ success: false, error: 'kept' })
    const { result } = renderHook(() => useNoteMutations(), { wrapper })

    await act(async () => {
      await result.current.deleteNote.mutateAsync('n1')
    })
    expect(queryClient.getQueryData(notesKeys.note('n1'))).toEqual(note('n1', 'First'))
  })
})
