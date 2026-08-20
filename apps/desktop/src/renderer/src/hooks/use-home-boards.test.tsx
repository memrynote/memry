import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useHomeBoards } from './use-home-boards'

const board = { id: 'b1', name: 'Work', position: 0, widgets: [] }

// Each remote-event subscription hands back its callback plus an unsubscribe spy.
const subscription = () => {
  const unsubscribe = vi.fn()
  const listeners: Array<(event: { id: string }) => void> = []
  const subscribe = vi.fn((cb: (event: { id: string }) => void) => {
    listeners.push(cb)
    return unsubscribe
  })
  return { subscribe, unsubscribe, fire: () => listeners.forEach((cb) => cb({ id: 'b1' })) }
}

let created: ReturnType<typeof subscription>
let updated: ReturnType<typeof subscription>
let deleted: ReturnType<typeof subscription>

beforeEach(() => {
  localStorage.clear()
  created = subscription()
  updated = subscription()
  deleted = subscription()
  // Assign only homePages onto the existing window.api (preserves jsdom window/document)
  ;(window as any).api = {
    ...((window as any).api ?? {}),
    homePages: {
      list: vi.fn().mockResolvedValue([board]),
      create: vi.fn().mockResolvedValue({ ...board, id: 'b2', name: 'New' }),
      update: vi.fn().mockResolvedValue(board),
      delete: vi.fn().mockResolvedValue({ success: true }),
      reorder: vi.fn().mockResolvedValue({ success: true })
    },
    onHomePageCreated: created.subscribe,
    onHomePageUpdated: updated.subscribe,
    onHomePageDeleted: deleted.subscribe
  }
})

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
      })
    }
  >
    {children}
  </QueryClientProvider>
)

describe('useHomeBoards', () => {
  it('loads boards and defaults active to first', async () => {
    const { result } = renderHook(() => useHomeBoards(), { wrapper })
    await waitFor(() => expect(result.current.boards).toHaveLength(1))
    expect(result.current.activeBoardId).toBe('b1')
  })

  it('updateWidgets calls api.update', async () => {
    const { result } = renderHook(() => useHomeBoards(), { wrapper })
    await waitFor(() => expect(result.current.boards).toHaveLength(1))
    await act(() => result.current.updateWidgets('b1', []))
    expect(window.api.homePages.update).toHaveBeenCalledWith({ id: 'b1', widgets: [] })
  })

  it('renameBoard calls api.update with the new name only', async () => {
    const { result } = renderHook(() => useHomeBoards(), { wrapper })
    await waitFor(() => expect(result.current.boards).toHaveLength(1))
    await act(() => result.current.renameBoard('b1', 'Planning'))
    expect(window.api.homePages.update).toHaveBeenCalledWith({ id: 'b1', name: 'Planning' })
  })

  it('reorderBoards calls api.reorder with the new id order', async () => {
    const { result } = renderHook(() => useHomeBoards(), { wrapper })
    await waitFor(() => expect(result.current.boards).toHaveLength(1))
    await act(() => result.current.reorderBoards(['b2', 'b1']))
    expect(window.api.homePages.reorder).toHaveBeenCalledWith(['b2', 'b1'])
  })

  // Boards sync, so a peer's create/rename/drag/delete arrives as an event
  // rather than a local mutation — without these the second device shows a stale
  // board until restart.
  it.each([
    ['created', () => created],
    ['updated', () => updated],
    ['deleted', () => deleted]
  ])('refetches when a remote %s event arrives', async (_name, get) => {
    const { result } = renderHook(() => useHomeBoards(), { wrapper })
    await waitFor(() => expect(result.current.boards).toHaveLength(1))
    const listMock = vi.mocked(window.api.homePages.list)
    listMock.mockClear()

    act(() => get().fire())

    await waitFor(() => expect(listMock).toHaveBeenCalled())
  })

  it('unsubscribes from all three events on unmount', async () => {
    const { result, unmount } = renderHook(() => useHomeBoards(), { wrapper })
    await waitFor(() => expect(result.current.boards).toHaveLength(1))

    unmount()

    expect(created.unsubscribe).toHaveBeenCalled()
    expect(updated.unsubscribe).toHaveBeenCalled()
    expect(deleted.unsubscribe).toHaveBeenCalled()
  })
})
