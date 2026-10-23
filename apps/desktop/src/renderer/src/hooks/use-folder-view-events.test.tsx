import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folderViewKeys } from './use-folder-view'
import { useFolderViewEvents } from './use-folder-view-events'

const mocks = vi.hoisted(() => ({
  noteListeners: {} as Record<string, () => void>,
  unsubscribe: vi.fn()
}))

vi.mock('@/services/notes-service', () => {
  const subscribe = (name: string) =>
    vi.fn((callback: () => void) => {
      mocks.noteListeners[name] = callback
      return mocks.unsubscribe
    })
  return {
    notesService: {},
    onTagsChanged: subscribe('tags-changed'),
    onNoteMoved: subscribe('moved'),
    onNoteDeleted: subscribe('deleted'),
    onNoteCreated: subscribe('created'),
    onNoteUpdated: subscribe('updated'),
    onNoteRenamed: subscribe('renamed'),
    onNoteExternalChange: subscribe('external')
  }
})

const SCOPE = { kind: 'folder', path: 'Notes' } as const

/** Longer than any coalescing window the hook is allowed to use. */
const PAST_THE_COALESCING_WINDOW_MS = 10_000

/**
 * Mounts the global event hook next to a real, active folder-view listing
 * query, so the assertions count actual refetches (queryFn calls) rather than
 * invalidation bookkeeping.
 */
function renderHarness() {
  const listNotes = vi.fn(async () => ({ notes: [] }))
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } }
  })

  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  const rendered = renderHook(
    () => {
      useFolderViewEvents()
      useQuery({ queryKey: folderViewKeys.notes(SCOPE), queryFn: listNotes })
    },
    { wrapper }
  )

  return { listNotes, queryClient, ...rendered }
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('useFolderViewEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    for (const key of Object.keys(mocks.noteListeners)) delete mocks.noteListeners[key]
    mocks.unsubscribe.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not refetch the listing while note updates keep arriving', async () => {
    const { listNotes } = renderHarness()
    await settle()
    expect(listNotes).toHaveBeenCalledTimes(1)

    // A typing session: the editor autosaves on a 1s debounce, and every save
    // emits notes:updated.
    for (let i = 0; i < 5; i++) {
      act(() => mocks.noteListeners.updated())
      await settle(1000)
    }

    expect(listNotes).toHaveBeenCalledTimes(1)
  })

  it('refetches the listing exactly once after the update burst ends', async () => {
    const { listNotes } = renderHarness()
    await settle()

    act(() => {
      mocks.noteListeners.updated()
      mocks.noteListeners.updated()
      mocks.noteListeners.updated()
    })
    await settle(PAST_THE_COALESCING_WINDOW_MS)

    expect(listNotes).toHaveBeenCalledTimes(2)
  })

  it.each(['created', 'renamed', 'moved', 'deleted', 'external'])(
    'refetches the listing immediately on note %s',
    async (event) => {
      const { listNotes } = renderHarness()
      await settle()

      act(() => mocks.noteListeners[event]())
      await settle()

      expect(listNotes).toHaveBeenCalledTimes(2)
    }
  )

  it('does not refetch again for updates a structural event already covered', async () => {
    const { listNotes } = renderHarness()
    await settle()

    act(() => mocks.noteListeners.updated())
    act(() => mocks.noteListeners.created())
    await settle(PAST_THE_COALESCING_WINDOW_MS)

    expect(listNotes).toHaveBeenCalledTimes(2)
  })

  it('drops a pending update refetch and unsubscribes on unmount', async () => {
    const { listNotes, queryClient, unmount } = renderHarness()
    await settle()
    // The unmounted listing is inactive, so a late timer would not show up as a
    // refetch — assert on the invalidation the timer would still fire.
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')

    act(() => mocks.noteListeners.updated())
    unmount()
    await settle(PAST_THE_COALESCING_WINDOW_MS)

    expect(listNotes).toHaveBeenCalledTimes(1)
    expect(invalidateQueries).not.toHaveBeenCalled()
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(6)
  })
})
