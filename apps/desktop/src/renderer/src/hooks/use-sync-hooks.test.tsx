import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSyncHistory } from './use-sync-history'
import { useSyncStatus } from './use-sync-status'
import { notesService } from '@/services/notes-service'

const mocks = vi.hoisted(() => ({
  syncState: {
    status: 'idle',
    lastSyncAt: null as number | null,
    pendingCount: 0,
    error: null as string | null,
    conflicts: [] as Array<{ itemId: string; itemType: string; detectedAt: number }>,
    sessionExpired: false,
    clockSkewDetected: false,
    initialSyncProgress: null as null | { current: number; total: number },
    syncActivity: { pushCount: 0, pullCount: 0 }
  },
  triggerSync: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  clearError: vi.fn(),
  getLocalOnlyCount: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ''}`
  })
}))

vi.mock('@/contexts/sync-context', () => ({
  useSync: () => ({
    state: mocks.syncState,
    triggerSync: mocks.triggerSync,
    pause: mocks.pause,
    resume: mocks.resume,
    clearError: mocks.clearError
  })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    getLocalOnlyCount: mocks.getLocalOnlyCount
  }
}))

const historyEntry = (id: number, overrides: Record<string, unknown> = {}) =>
  ({
    id: `history-${id}`,
    type: 'push',
    itemType: 'note',
    itemId: `note-${id}`,
    itemCount: 1,
    durationMs: 10,
    createdAt: Date.now() - id * 1000,
    ...overrides
  }) as any

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('sync hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(mocks.syncState, {
      status: 'idle',
      lastSyncAt: null,
      pendingCount: 0,
      error: null,
      conflicts: [],
      sessionExpired: false,
      clockSkewDetected: false,
      initialSyncProgress: null,
      syncActivity: { pushCount: 0, pullCount: 0 }
    })
    mocks.getLocalOnlyCount.mockResolvedValue({ count: 2 })
    ;(window as any).api = {
      ...(window as any).api,
      syncOps: {
        getHistory: vi.fn().mockResolvedValue({
          entries: Array.from({ length: 20 }, (_, i) => historyEntry(i + 1)),
          total: 20
        })
      }
    }
  })

  it('derives sync status labels, issue flags, local-only counts, and actions', async () => {
    mocks.syncState.pendingCount = 3
    const { result, rerender } = renderHook(() => useSyncStatus(), { wrapper })

    await waitFor(() => expect(result.current.localOnlyCount).toBe(2))
    expect(result.current.label).toBe('account.sync.statuses.changesPending{"count":3}')
    expect(result.current.dotColor).toBe('bg-amber-500')
    expect(result.current.hasIssues).toBe(false)

    mocks.syncState.status = 'syncing'
    mocks.syncState.pendingCount = 0
    mocks.syncState.syncActivity = { pushCount: 2, pullCount: 1 }
    rerender()
    expect(result.current.label).toBe(
      'account.sync.statuses.pushedPulled{"parts":"account.sync.statuses.pushed{\\"count\\":2}, account.sync.statuses.pulled{\\"count\\":1}"}'
    )
    expect(result.current.isAnimating).toBe(true)

    mocks.syncState.status = 'offline'
    mocks.syncState.pendingCount = 5
    rerender()
    expect(result.current.label).toBe('account.sync.statuses.offlinePending{"count":5}')

    mocks.syncState.status = 'local_only'
    mocks.syncState.pendingCount = 0
    rerender()
    expect(result.current.label).toBe('account.sync.statuses.localOnly')
    expect(result.current.dotColor).toBe('bg-gray-400')

    mocks.syncState.status = 'unknown-status'
    mocks.syncState.error = 'sync failed'
    mocks.syncState.conflicts = [{ itemId: 'n1', itemType: 'note', detectedAt: 1 }]
    rerender()
    expect(result.current.label).toBe('account.sync.statuses.connecting')
    expect(result.current.hasIssues).toBe(true)

    await result.current.triggerSync()
    await result.current.pause()
    await result.current.resume()
    result.current.clearError()
    expect(mocks.triggerSync).toHaveBeenCalled()
    expect(mocks.pause).toHaveBeenCalled()
    expect(mocks.resume).toHaveBeenCalled()
    expect(mocks.clearError).toHaveBeenCalled()
    expect(notesService.getLocalOnlyCount).toHaveBeenCalled()
  })

  it('loads, filters, paginates, refreshes, and reloads sync history after sync changes', async () => {
    const firstPage = [
      ...Array.from({ length: 20 }, (_, i) => historyEntry(i + 1)),
      historyEntry(21, { type: 'pull', itemCount: 0 }),
      historyEntry(22, { type: 'error', itemCount: 0 })
    ]
    const secondPage = [historyEntry(23, { type: 'pull', itemCount: 2 })]
    ;(window as any).api.syncOps.getHistory
      .mockResolvedValueOnce({ entries: firstPage, total: 23 })
      .mockResolvedValueOnce({ entries: secondPage, total: 23 })
      .mockResolvedValueOnce({ entries: [historyEntry(99, { type: 'error' })], total: 1 })

    const { result, rerender } = renderHook(() => useSyncHistory())

    await waitFor(() => expect(result.current.entries).toHaveLength(20))
    expect(result.current.hasMore).toBe(true)

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.entries).toHaveLength(21))

    act(() => result.current.loadMore())
    await waitFor(() =>
      expect((window as any).api.syncOps.getHistory).toHaveBeenCalledWith({
        limit: 100,
        offset: 22
      })
    )
    await waitFor(() =>
      expect(result.current.entries.some((entry) => entry.id === 'history-23')).toBe(true)
    )

    act(() => result.current.setFilter({ type: 'error' }))
    expect(result.current.filter.type).toBe('error')
    await waitFor(() =>
      expect(result.current.entries.map((entry) => entry.type)).toEqual(['error'])
    )

    act(() => result.current.setFilter({ period: 'today' }))
    expect(result.current.filter.period).toBe('today')

    act(() => result.current.refresh())
    await waitFor(() =>
      expect((window as any).api.syncOps.getHistory).toHaveBeenLastCalledWith({
        limit: 100,
        offset: 0
      })
    )

    mocks.syncState.lastSyncAt = Date.now()
    rerender()
    await waitFor(() => expect((window as any).api.syncOps.getHistory).toHaveBeenCalledTimes(4))
  })

  it('keeps existing history data when history IPC fails', async () => {
    ;(window as any).api.syncOps.getHistory
      .mockResolvedValueOnce({ entries: [historyEntry(1)], total: 1 })
      .mockRejectedValueOnce(new Error('ipc failed'))

    const { result } = renderHook(() => useSyncHistory())
    await waitFor(() => expect(result.current.entries).toHaveLength(1))

    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.entries).toHaveLength(1)
  })
})
