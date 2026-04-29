import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useSubtasks } from './use-subtasks'
import {
  createTestQueryClient,
  createMockTask,
  setupHookTestEnvironment,
  cleanupHookTestEnvironment
} from '@tests/utils/hook-test-wrapper'

describe('useSubtasks', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    setupHookTestEnvironment()
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.clearAllMocks()
  })

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  it('fetches subtasks by parent id', async () => {
    const subs = [
      createMockTask({ id: 's1', title: 'Sub 1' }),
      createMockTask({
        id: 's2',
        title: 'Sub 2',
        completedAt: '2026-04-28T10:00:00Z'
      })
    ]
    ;(window.api.tasks.getSubtasks as ReturnType<typeof vi.fn>).mockResolvedValue(subs)

    const { result } = renderHook(() => useSubtasks('t1'), { wrapper })
    await waitFor(() => expect(result.current.data?.length).toBe(2))
    expect(window.api.tasks.getSubtasks).toHaveBeenCalledWith('t1')
  })

  it('does not fetch when parentId is null', () => {
    const { result } = renderHook(() => useSubtasks(null), { wrapper })
    expect(window.api.tasks.getSubtasks).not.toHaveBeenCalled()
    expect(result.current.data).toBeUndefined()
  })
})
