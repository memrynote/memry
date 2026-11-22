import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    moved: [] as EmptyHandler[],
    external: [] as NoteHandler[],
    tagsChanged: [] as EmptyHandler[],
    folderConfigUpdated: [] as EmptyHandler[],
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
  onNoteMoved: (callback: EmptyHandler) => {
    mocks.handlers.moved.push(callback)
    return vi.fn()
  },
  onNoteExternalChange: (callback: NoteHandler) => {
    mocks.handlers.external.push(callback)
    return vi.fn()
  },
  onTagsChanged: (callback: EmptyHandler) => {
    mocks.handlers.tagsChanged.push(callback)
    return vi.fn()
  },
  onFolderConfigUpdated: (callback: EmptyHandler) => {
    mocks.handlers.folderConfigUpdated.push(callback)
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

  it('fetches note lists and invalidates them on create, rename, move, update, and delete events', async () => {
    const { result } = renderHook(() => useNotesList({ folder: 'Work' }), { wrapper })

    await waitFor(() => expect(result.current.notes[0]?.title).toBe('First'))
    expect(mocks.notesService.list).toHaveBeenCalledWith({ folder: 'Work' })

    mocks.notesService.list.mockResolvedValue({
      notes: [listItem('n2', 'Second')],
      total: 1,
      hasMore: false
    } satisfies NoteListResponse)

    const events = [
      () => mocks.handlers.created[0](),
      () => mocks.handlers.updated[0]({ id: 'n2' }),
      () => mocks.handlers.renamed[0]({ id: 'n2' }),
      () => mocks.handlers.moved[0](),
      () => mocks.handlers.deleted[0]({ id: 'n2' })
    ]
    for (const [i, fire] of events.entries()) {
      // Apart, so each event is the first of its own burst.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        fire()
      })
      await waitFor(() => expect(mocks.notesService.list).toHaveBeenCalledTimes(i + 2))
    }
    expect(result.current.notes[0]?.title).toBe('Second')
  })

  it('refetches a burst of note events once at its start and once at its end', async () => {
    const { result } = renderHook(() => useNotesList({ folder: 'Work' }), { wrapper })
    await waitFor(() => expect(result.current.notes[0]?.title).toBe('First'))

    mocks.notesService.list.mockResolvedValue({
      notes: [listItem('n2', 'Moved')],
      total: 1,
      hasMore: false
    } satisfies NoteListResponse)

    // A folder rename sends one event per note it moved.
    await act(async () => {
      for (let i = 0; i < 2500; i++) mocks.handlers.moved[0]()
    })
    await waitFor(() => expect(mocks.notesService.list).toHaveBeenCalledTimes(3))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(mocks.notesService.list).toHaveBeenCalledTimes(3)
    expect(result.current.notes[0]?.title).toBe('Moved')
  })

  it('#5398: a bootstrap write-back stream refetches the lists by cost, not once per note', async () => {
    vi.useFakeTimers()
    try {
      // Main answers with the vault as it is when the call lands, after the
      // time a full listNotes takes on a large vault.
      const LIST_MS = 400
      let latest = 'First'
      mocks.notesService.list.mockImplementation(() => {
        const title = latest
        return new Promise<NoteListResponse>((resolve) =>
          setTimeout(
            () => resolve({ notes: [listItem('n1', title)], total: 1, hasMore: false }),
            LIST_MS
          )
        )
      })
      const tree = renderHook(() => useNotesList({ fields: 'tree' }), { wrapper })
      renderHook(() => useNotesList({ sortBy: 'modified', sortOrder: 'desc' }), { wrapper })
      await vi.advanceTimersByTimeAsync(LIST_MS)
      expect(mocks.notesService.list).toHaveBeenCalledTimes(2)
      const fireUpdated = (event: NoteEvent & { source: string }) => {
        for (const handler of mocks.handlers.updated) handler(event)
      }

      // The settle phase writes back one body about every 250 ms.
      const WRITE_BACKS = 1000
      const GAP_MS = 250
      for (let i = 0; i < WRITE_BACKS; i++) {
        latest = `Body ${i}`
        fireUpdated({ id: `n${i}`, changes: { content: latest }, source: 'sync' })
        await vi.advanceTimersByTimeAsync(GAP_MS)
      }
      await vi.advanceTimersByTimeAsync(60_000)

      // Each refetch is followed by a rest of ten times its cost, and one
      // refetch covers both mounted lists.
      const maxRounds = Math.ceil((WRITE_BACKS * GAP_MS) / (LIST_MS * 11)) + 2
      const bootstrapCalls = mocks.notesService.list.mock.calls.length - 2
      expect(bootstrapCalls).toBeLessThanOrEqual(maxRounds * 2)
      // The lists end where an unbatched run ends.
      expect(tree.result.current.notes[0]?.title).toBe(`Body ${WRITE_BACKS - 1}`)

      // A single edit after the burst refreshes at once.
      const before = mocks.notesService.list.mock.calls.length
      latest = 'Edited'
      fireUpdated({ id: 'n1', changes: { content: latest }, source: 'internal' })
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.notesService.list).toHaveBeenCalledTimes(before + 2)
      await vi.advanceTimersByTimeAsync(LIST_MS + 10)
      expect(tree.result.current.notes[0]?.title).toBe('Edited')
    } finally {
      vi.useRealTimers()
    }
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
})
