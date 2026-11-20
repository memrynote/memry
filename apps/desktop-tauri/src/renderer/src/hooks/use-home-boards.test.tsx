import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useHomeBoards } from './use-home-boards'

const service = vi.hoisted(() => ({
  homePagesService: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn()
  },
  onHomePageCreated: vi.fn(),
  onHomePageUpdated: vi.fn(),
  onHomePageDeleted: vi.fn()
}))
vi.mock('@/services/home-pages-service', () => service)
const api = service.homePagesService

const board = { id: 'b1', name: 'Work', position: 0, widgets: [] }

// Each remote-event subscription hands back its callback plus an unsubscribe spy.
const subscription = () => {
  const unsubscribe = vi.fn()
  const listeners: Array<(event: { id: string }) => void> = []
  const subscribe = vi.fn((cb: (event: { id: string }) => void) => {
    listeners.push(cb)
    return unsubscribe
  })
  return {
    subscribe,
    unsubscribe,
    fire: () => listeners.forEach((cb) => cb({ id: 'b1' }))
  }
}

let created: ReturnType<typeof subscription>
let updated: ReturnType<typeof subscription>
let deleted: ReturnType<typeof subscription>

beforeEach(() => {
  localStorage.clear()
  created = subscription()
  updated = subscription()
  deleted = subscription()
  api.list.mockReset().mockResolvedValue([board])
  api.create.mockReset().mockResolvedValue({ ...board, id: 'b2', name: 'New' })
  api.update.mockReset().mockResolvedValue(board)
  api.delete.mockReset().mockResolvedValue({ success: true })
  api.reorder.mockReset().mockResolvedValue({ success: true })
  service.onHomePageCreated.mockImplementation(created.subscribe)
  service.onHomePageUpdated.mockImplementation(updated.subscribe)
  service.onHomePageDeleted.mockImplementation(deleted.subscribe)
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
    expect(api.update).toHaveBeenCalledWith({ id: 'b1', widgets: [] })
  })

  it('renameBoard calls api.update with the new name only', async () => {
    const { result } = renderHook(() => useHomeBoards(), { wrapper })
    await waitFor(() => expect(result.current.boards).toHaveLength(1))
    await act(() => result.current.renameBoard('b1', 'Planning'))
    expect(api.update).toHaveBeenCalledWith({ id: 'b1', name: 'Planning' })
  })

  it('reorderBoards calls api.reorder with the new id order', async () => {
    const { result } = renderHook(() => useHomeBoards(), { wrapper })
    await waitFor(() => expect(result.current.boards).toHaveLength(1))
    await act(() => result.current.reorderBoards(['b2', 'b1']))
    expect(api.reorder).toHaveBeenCalledWith(['b2', 'b1'])
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
    const listMock = api.list
    listMock.mockClear()

    act(() => get().fire())

    await waitFor(() => expect(listMock).toHaveBeenCalled())
  })

  // The tab title is rendered from a second `useHomeBoards()` mounted above the
  // tab tree, so a switch made on the Home page has to reach it. `localStorage`
  // alone notifies nobody — a per-instance `useState` would leave the other
  // consumer on the value it read at mount.
  it('shares the active board id across hook instances', async () => {
    const second = { ...board, id: 'b2', name: 'Work' }
    api.list.mockResolvedValue([board, second])
    const { result: page } = renderHook(() => useHomeBoards(), { wrapper })
    const { result: elsewhere } = renderHook(() => useHomeBoards(), { wrapper })
    await waitFor(() => expect(elsewhere.current.boards).toHaveLength(2))

    act(() => page.current.setActiveBoardId('b2'))

    expect(elsewhere.current.activeBoardId).toBe('b2')
    expect(elsewhere.current.activeBoard?.name).toBe('Work')
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
