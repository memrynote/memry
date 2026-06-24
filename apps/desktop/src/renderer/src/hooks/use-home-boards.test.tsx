import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useHomeBoards } from './use-home-boards'

const board = { id: 'b1', name: 'Work', position: 0, widgets: [] }

beforeEach(() => {
  localStorage.clear()
  // Assign only homePages onto the existing window.api (preserves jsdom window/document)
  ;(window as any).api = {
    ...((window as any).api ?? {}),
    homePages: {
      list: vi.fn().mockResolvedValue([board]),
      create: vi.fn().mockResolvedValue({ ...board, id: 'b2', name: 'New' }),
      update: vi.fn().mockResolvedValue(board),
      delete: vi.fn().mockResolvedValue({ success: true }),
      reorder: vi.fn().mockResolvedValue({ success: true })
    }
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
})
