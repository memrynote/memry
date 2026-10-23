import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NOTE_TREE_PAGE_SIZE, useNoteTreeData } from './use-note-tree-data'
import type { NoteListItem } from '@memry/rpc/notes'

type ListOptions = { limit?: number; offset?: number }

const mocks = vi.hoisted(() => ({
  notesService: {
    list: vi.fn(),
    getFolders: vi.fn(),
    getAllPositions: vi.fn(),
    getFolderConfig: vi.fn(),
    setFolderConfig: vi.fn(),
    createFolder: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    rename: vi.fn(),
    move: vi.fn()
  }
}))

vi.mock('@/services/notes-service', () => {
  const unsubscribe = () => vi.fn()
  return {
    notesService: mocks.notesService,
    onNoteCreated: unsubscribe,
    onNoteUpdated: unsubscribe,
    onNoteDeleted: unsubscribe,
    onNoteRenamed: unsubscribe,
    onNoteMoved: unsubscribe,
    onNoteExternalChange: unsubscribe,
    onTagsChanged: unsubscribe,
    onFolderConfigUpdated: unsubscribe
  }
})

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/**
 * A vault big enough to overflow one page. The rows are flat (no folder
 * segments) so `buildTreeFromNotes` puts every one of them in `rootNotes`.
 */
function makeVault(size: number): NoteListItem[] {
  return Array.from(
    { length: size },
    (_, index) =>
      ({
        id: `note-${index}`,
        path: `Note ${index}.md`,
        title: `Note ${index}`,
        created: new Date(0),
        modified: new Date(0),
        tags: [],
        wordCount: 0,
        emoji: null,
        localOnly: false,
        fileType: 'markdown'
      }) as unknown as NoteListItem
  )
}

/** Serves `vault` the way `listNotes` does: one `limit`-sized page plus the real total. */
function serve(vault: NoteListItem[], onCall?: (options: ListOptions) => void) {
  mocks.notesService.list.mockImplementation(async (options: ListOptions = {}) => {
    onCall?.(options)
    const limit = options.limit ?? 100
    const offset = options.offset ?? 0
    const page = vault.slice(offset, offset + limit)
    return { notes: page, total: vault.length, hasMore: offset + page.length < vault.length }
  })
}

describe('useNoteTreeData truncation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.notesService.getFolders.mockResolvedValue([])
    mocks.notesService.getAllPositions.mockResolvedValue({ success: true, positions: {} })
  })

  it('reports the notes the first page could not cover', async () => {
    const vault = makeVault(NOTE_TREE_PAGE_SIZE + 500)
    serve(vault)

    const { result } = renderHook(() => useNoteTreeData(), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // The page itself is unchanged — still bounded at the ceiling.
    expect(result.current.notes).toHaveLength(NOTE_TREE_PAGE_SIZE)
    expect(result.current.tree.rootNotes).toHaveLength(NOTE_TREE_PAGE_SIZE)
    // ...but the overflow is now reported instead of vanishing.
    expect(result.current.hiddenNoteCount).toBe(500)
  })

  it('reports nothing hidden when the vault fits in one page', async () => {
    serve(makeVault(42))

    const { result } = renderHook(() => useNoteTreeData(), { wrapper })

    await waitFor(() => expect(result.current.notes).toHaveLength(42))
    expect(result.current.hiddenNoteCount).toBe(0)
  })

  it('loadMore pulls the rest of the vault into the tree', async () => {
    const vault = makeVault(NOTE_TREE_PAGE_SIZE + 500)
    const limits: number[] = []
    serve(vault, (options) => limits.push(options.limit ?? 0))

    const { result } = renderHook(() => useNoteTreeData(), { wrapper })

    await waitFor(() => expect(result.current.hiddenNoteCount).toBe(500))

    act(() => result.current.loadMore())

    await waitFor(() => expect(result.current.notes).toHaveLength(vault.length))
    expect(result.current.hiddenNoteCount).toBe(0)
    expect(result.current.tree.rootNotes).toHaveLength(vault.length)
    // The last note in the vault — the one the first page dropped — is reachable.
    expect(result.current.noteMap.has(`note-${vault.length - 1}`)).toBe(true)
    expect(limits).toEqual([NOTE_TREE_PAGE_SIZE, NOTE_TREE_PAGE_SIZE * 2])
  })

  it('keeps the loaded tree on screen while the next page is in flight', async () => {
    const vault = makeVault(NOTE_TREE_PAGE_SIZE + 500)
    let release: (() => void) | null = null
    mocks.notesService.list.mockImplementation(async (options: ListOptions = {}) => {
      const limit = options.limit ?? 100
      if (limit > NOTE_TREE_PAGE_SIZE) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      const page = vault.slice(0, limit)
      return { notes: page, total: vault.length, hasMore: page.length < vault.length }
    })

    const { result } = renderHook(() => useNoteTreeData(), { wrapper })

    await waitFor(() => expect(result.current.hiddenNoteCount).toBe(500))

    act(() => result.current.loadMore())

    await waitFor(() => expect(result.current.isLoadingMore).toBe(true))
    // The sidebar must not fall back to a skeleton mid-page: the tree it already
    // has stays mounted, and the footer carries the pending state.
    expect(result.current.isLoading).toBe(false)
    expect(result.current.notes).toHaveLength(NOTE_TREE_PAGE_SIZE)
    expect(result.current.hiddenNoteCount).toBe(500)

    await act(async () => {
      release?.()
    })

    await waitFor(() => expect(result.current.notes).toHaveLength(vault.length))
    expect(result.current.isLoadingMore).toBe(false)
  })
})
