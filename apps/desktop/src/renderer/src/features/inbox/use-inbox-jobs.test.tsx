import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inboxKeys } from '@/hooks/inbox-query-keys'
import { useInboxJobs } from './use-inbox-jobs'

const mocks = vi.hoisted(() => ({
  getJobs: vi.fn(),
  listeners: {} as Record<string, () => void>,
  unsubscribers: [] as Array<ReturnType<typeof vi.fn>>
}))

vi.mock('@/services/inbox-service', () => {
  const subscribe = (name: string) =>
    vi.fn((callback: () => void) => {
      mocks.listeners[name] = callback
      const unsubscribe = vi.fn()
      mocks.unsubscribers.push(unsubscribe)
      return unsubscribe
    })

  return {
    inboxService: {
      getJobs: (...args: unknown[]) => mocks.getJobs(...args)
    },
    onInboxCaptured: subscribe('captured'),
    onInboxUpdated: subscribe('updated'),
    onInboxArchived: subscribe('archived'),
    onInboxMetadataComplete: subscribe('metadata'),
    onInboxTranscriptionComplete: subscribe('transcription'),
    onInboxProcessingError: subscribe('processingError')
  }
})

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

describe('useInboxJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners = {}
    mocks.unsubscribers = []
    mocks.getJobs.mockResolvedValue({
      jobs: [
        { id: 'job-1', itemId: 'item-a', status: 'pending' },
        { id: 'job-2', itemId: 'item-a', status: 'running' },
        { id: 'job-3', itemId: 'item-b', status: 'failed' },
        { id: 'job-4', itemId: 'item-b', status: 'completed' }
      ]
    })
  })

  it('loads jobs for normalized item ids, groups them, counts active and failed jobs', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result, unmount } = renderHook(() => useInboxJobs(['item-b', '', 'item-a', 'item-a']), {
      wrapper: wrapper(queryClient)
    })

    await waitFor(() =>
      expect(mocks.getJobs).toHaveBeenCalledWith({ itemIds: ['item-a', 'item-b'] })
    )
    await waitFor(() => expect(result.current.jobs).toHaveLength(4))
    expect(result.current.jobs).toHaveLength(4)
    expect(result.current.jobsByItemId['item-a']).toHaveLength(2)
    expect(result.current.activeCount).toBe(2)
    expect(result.current.failedCount).toBe(1)
    expect(result.current.error).toBeNull()

    act(() => {
      mocks.listeners.captured()
      mocks.listeners.updated()
      mocks.listeners.archived()
      mocks.listeners.metadata()
      mocks.listeners.transcription()
      mocks.listeners.processingError()
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.all })

    const beforeRefetchCount = mocks.getJobs.mock.calls.length
    await act(async () => {
      result.current.refetch()
    })
    expect(mocks.getJobs.mock.calls.length).toBeGreaterThan(beforeRefetchCount)

    unmount()
    for (const unsubscribe of mocks.unsubscribers) {
      expect(unsubscribe).toHaveBeenCalled()
    }
  })

  it('loads all jobs when no item ids are provided and exposes query errors', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    mocks.getJobs.mockRejectedValueOnce(new Error('jobs failed'))

    const { result } = renderHook(() => useInboxJobs(), { wrapper: wrapper(queryClient) })

    await waitFor(() => expect(result.current.error?.message).toBe('jobs failed'))
    expect(mocks.getJobs).toHaveBeenCalledWith(undefined)
    expect(result.current.jobs).toEqual([])
    expect(result.current.jobsByItemId).toEqual({})
  })
})
