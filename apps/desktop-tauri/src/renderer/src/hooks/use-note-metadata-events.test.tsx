import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNoteFoldersQuery, useNoteTagsQuery } from './use-notes-query'
import { useNoteMetadataEvents } from './use-note-metadata-events'

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, Array<() => void>>,
  getAllWithCounts: vi.fn(),
  getFolders: vi.fn(),
  listCategories: vi.fn()
}))

/**
 * A Tauri subscription as `subscribeToEvent` delivers it: live once main answers `listen`, which
 * is after the first read of a list the page opened with (a read in flight absorbs an invalidation).
 */
function subscription(name: string) {
  return (callback: () => void, onListening?: () => void) => {
    ;(mocks.handlers[name] ??= []).push(callback)
    setTimeout(() => onListening?.(), 5)
    return vi.fn()
  }
}

vi.mock('@/services/notes-service', () => ({
  notesService: { getFolders: () => mocks.getFolders() },
  onTagsChanged: subscription('tags'),
  onFolderConfigUpdated: subscription('folderConfig'),
  onNoteCreated: subscription('created'),
  onNoteDeleted: subscription('deleted'),
  onNoteMoved: subscription('moved'),
  onNoteRenamed: subscription('renamed')
}))

vi.mock('@/services/tags-service', () => ({
  tagsService: { getAllWithCounts: () => mocks.getAllWithCounts() },
  onTagCategoriesChanged: subscription('categories')
}))

const READERS = 5

function renderReaders(hook: () => unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  for (let i = 0; i < READERS; i++) renderHook(hook, { wrapper })
  return { queryClient, wrapper }
}

/** Lets the listeners go live and the invalidations they make settle. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 40))))

beforeEach(() => {
  for (const key of Object.keys(mocks.handlers)) delete mocks.handlers[key]
  mocks.getAllWithCounts.mockReset().mockResolvedValue({ tags: [] })
  mocks.getFolders.mockReset().mockResolvedValue([])
  mocks.listCategories.mockReset()
})

describe('useNoteMetadataEvents', () => {
  it('leaves the tag list to one read however many readers mount', async () => {
    renderReaders(() => useNoteTagsQuery())
    await settle()

    expect(mocks.getAllWithCounts).toHaveBeenCalledTimes(1)
    expect(mocks.handlers.tags ?? []).toHaveLength(0)
  })

  it('reads the tag list once more when the listener goes live, and once per tag change', async () => {
    const { wrapper } = renderReaders(() => useNoteTagsQuery())
    renderHook(() => useNoteMetadataEvents(), { wrapper })
    await settle()
    expect(mocks.getAllWithCounts).toHaveBeenCalledTimes(2)
    expect(mocks.handlers.tags).toHaveLength(1)

    await act(async () => mocks.handlers.tags[0]())
    await waitFor(() => expect(mocks.getAllWithCounts).toHaveBeenCalledTimes(3))
  })

  it('reads the folder list once for all its readers, again on a note event', async () => {
    const { wrapper } = renderReaders(() => useNoteFoldersQuery())
    renderHook(() => useNoteMetadataEvents(), { wrapper })
    await settle()
    expect(mocks.getFolders).toHaveBeenCalledTimes(2)
    expect(mocks.handlers.created).toHaveLength(1)

    await act(async () => mocks.handlers.folderConfig[0]())
    await waitFor(() => expect(mocks.getFolders).toHaveBeenCalledTimes(3))
  })

  it('reads the tags again with the tag categories, so a tag moved between categories shows', async () => {
    const { wrapper } = renderReaders(() => useNoteTagsQuery())
    renderHook(() => useNoteMetadataEvents(), { wrapper })
    await settle()
    expect(mocks.getAllWithCounts).toHaveBeenCalledTimes(2)

    await act(async () => mocks.handlers.categories[0]())
    await waitFor(() => expect(mocks.getAllWithCounts).toHaveBeenCalledTimes(3))
  })

  it('reads the tags again when the first read of the list was out before the change', async () => {
    // The first read took the list before the tag changed and answers after the listener went
    // live: its answer must not stand for the change (#4295).
    let answerFirst: (value: { tags: unknown[] }) => void = () => {}
    mocks.getAllWithCounts.mockReset()
    mocks.getAllWithCounts.mockImplementationOnce(
      () => new Promise((resolve) => (answerFirst = resolve))
    )
    mocks.getAllWithCounts.mockResolvedValue({ tags: [{ name: 'fresh', count: 1 }] })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useNoteTagsQuery(), { wrapper })
    renderHook(() => useNoteMetadataEvents(), { wrapper })
    await settle()
    await act(async () => answerFirst({ tags: [{ name: 'stale', count: 1 }] }))

    await waitFor(() => expect(result.current.tags.map((tag) => tag.tag)).toEqual(['fresh']))
  })

  it('reads the folders again when the first read of the list was out before the change', async () => {
    let answerFirst: (value: string[]) => void = () => {}
    mocks.getFolders.mockReset()
    mocks.getFolders.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
    mocks.getFolders.mockResolvedValue(['fresh'])
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useNoteFoldersQuery(), { wrapper })
    renderHook(() => useNoteMetadataEvents(), { wrapper })
    await settle()
    await act(async () => answerFirst(['stale']))

    await waitFor(() => expect(result.current.folders).toEqual(['fresh']))
  })
})
