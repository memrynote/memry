import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useTask } from './use-task'
import {
  createTestQueryClient,
  createMockTask,
  setupHookTestEnvironment,
  cleanupHookTestEnvironment
} from '@tests/utils/hook-test-wrapper'

describe('useTask', () => {
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

  it('fetches a task by id', async () => {
    const task = createMockTask({ id: 't1', title: 'Hello', projectId: 'p1' })
    ;(window.api.tasks.get as ReturnType<typeof vi.fn>).mockResolvedValue(task)

    const { result } = renderHook(() => useTask('t1'), { wrapper })

    await waitFor(() => expect(result.current.data?.title).toBe('Hello'))
    expect(window.api.tasks.get).toHaveBeenCalledWith('t1')
  })

  it('does not fetch when id is null', () => {
    const { result } = renderHook(() => useTask(null), { wrapper })
    expect(window.api.tasks.get).not.toHaveBeenCalled()
    expect(result.current.data).toBeUndefined()
  })
})
