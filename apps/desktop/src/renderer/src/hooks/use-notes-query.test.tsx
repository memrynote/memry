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
import type { Note, NoteLinksResponse, NoteListItem, NoteListResponse } from '@memry/rpc/notes'

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
    folderConfigUpdated: [] as EmptyHandler[]
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
    } as NoteLinksResponse)
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
    } as NoteLinksResponse)
    await act(async () => {
      mocks.handlers.updated.find(Boolean)?.({ id: 'other', changes: { content: 'changed' } })
    })
    await waitFor(() => expect(linksHook.result.current.incoming[0]?.title).toBe('Third'))
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
