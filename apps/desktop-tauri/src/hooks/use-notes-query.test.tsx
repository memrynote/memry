import type { ReactNode } from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { notesService } from '@/services/notes-service'
import { useNote, useNotesList, useNoteTagsQuery } from './use-notes-query'

const noteEventHandlers = vi.hoisted(() => ({
  created: null as (() => void) | null,
  updated: null as (() => void) | null,
  deleted: null as (() => void) | null,
  folderDeleted: null as (() => void) | null,
  folderRenamed: null as (() => void) | null,
  tagsChanged: null as (() => void) | null
}))

vi.mock('@/services/notes-service', () => {
  const unsubscribe = vi.fn()
  return {
    notesService: {
      get: vi.fn(),
      getTags: vi.fn(),
      list: vi.fn()
    },
    onNoteCreated: vi.fn((callback: () => void) => {
      noteEventHandlers.created = callback
      return unsubscribe
    }),
    onNoteUpdated: vi.fn((callback: () => void) => {
      noteEventHandlers.updated = callback
      return unsubscribe
    }),
    onNoteDeleted: vi.fn((callback: () => void) => {
      noteEventHandlers.deleted = callback
      return unsubscribe
    }),
    onNoteRenamed: vi.fn(() => unsubscribe),
    onNoteMoved: vi.fn(() => unsubscribe),
    onNoteExternalChange: vi.fn(() => unsubscribe),
    onTagsChanged: vi.fn((callback: () => void) => {
      noteEventHandlers.tagsChanged = callback
      return unsubscribe
    }),
    onFolderConfigUpdated: vi.fn(() => unsubscribe),
    onFolderRenamed: vi.fn((callback: () => void) => {
      noteEventHandlers.folderRenamed = callback
      return unsubscribe
    }),
    onFolderDeleted: vi.fn((callback: () => void) => {
      noteEventHandlers.folderDeleted = callback
      return unsubscribe
    })
  }
})

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false
      }
    }
  })

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

describe('useNote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    noteEventHandlers.folderRenamed = null
  })

  it('refreshes an open note after folder rename events', async () => {
    vi.mocked(notesService.get)
      .mockResolvedValueOnce({ id: 'note-1', path: 'notes/Inbox/doc.md', title: 'Doc' } as never)
      .mockResolvedValueOnce({
        id: 'note-1',
        path: 'notes/Archive/doc.md',
        title: 'Doc'
      } as never)

    const { result } = renderHook(() => useNote('note-1'), {
      wrapper: createWrapper()
    })

    await waitFor(() => {
      expect(result.current.note?.path).toBe('notes/Inbox/doc.md')
    })

    noteEventHandlers.folderRenamed?.()

    await waitFor(() => {
      expect(result.current.note?.path).toBe('notes/Archive/doc.md')
    })
    expect(notesService.get).toHaveBeenCalledTimes(2)
  })
})

describe('useNoteTagsQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    noteEventHandlers.created = null
    noteEventHandlers.updated = null
    noteEventHandlers.deleted = null
    noteEventHandlers.folderDeleted = null
    noteEventHandlers.folderRenamed = null
    noteEventHandlers.tagsChanged = null
  })

  it('loads tags from the notes backend', async () => {
    vi.mocked(notesService.getTags).mockResolvedValue([{ tag: 'work', color: '#3366ff', count: 2 }])

    const { result } = renderHook(() => useNoteTagsQuery(), {
      wrapper: createWrapper()
    })

    await waitFor(() => {
      expect(result.current.tags).toEqual([{ tag: 'work', color: '#3366ff', count: 2 }])
    })
    expect(notesService.getTags).toHaveBeenCalledTimes(1)
  })

  it('refreshes tags after note update events', async () => {
    vi.mocked(notesService.getTags)
      .mockResolvedValueOnce([{ tag: 'work', color: '#3366ff', count: 1 }])
      .mockResolvedValueOnce([{ tag: 'work', color: '#3366ff', count: 2 }])

    const { result } = renderHook(() => useNoteTagsQuery(), {
      wrapper: createWrapper()
    })

    await waitFor(() => {
      expect(result.current.tags).toEqual([{ tag: 'work', color: '#3366ff', count: 1 }])
    })

    noteEventHandlers.updated?.()

    await waitFor(() => {
      expect(result.current.tags).toEqual([{ tag: 'work', color: '#3366ff', count: 2 }])
    })
    expect(notesService.getTags).toHaveBeenCalledTimes(2)
  })
})

describe('useNotesList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    noteEventHandlers.folderDeleted = null
    noteEventHandlers.folderRenamed = null
  })

  it('refreshes lists after bulk folder mutations', async () => {
    vi.mocked(notesService.list)
      .mockResolvedValueOnce({
        notes: [{ id: 'note-1', path: 'notes/Inbox/doc.md', title: 'Doc' }],
        total: 1,
        hasMore: false
      } as never)
      .mockResolvedValueOnce({
        notes: [{ id: 'note-1', path: 'notes/Archive/doc.md', title: 'Doc' }],
        total: 1,
        hasMore: false
      } as never)
      .mockResolvedValueOnce({ notes: [], total: 0, hasMore: false } as never)

    const { result } = renderHook(() => useNotesList(), {
      wrapper: createWrapper()
    })

    await waitFor(() => {
      expect(result.current.notes[0]?.path).toBe('notes/Inbox/doc.md')
    })

    noteEventHandlers.folderRenamed?.()

    await waitFor(() => {
      expect(result.current.notes[0]?.path).toBe('notes/Archive/doc.md')
    })

    noteEventHandlers.folderDeleted?.()

    await waitFor(() => {
      expect(result.current.notes).toEqual([])
    })
    expect(notesService.list).toHaveBeenCalledTimes(3)
  })
})
