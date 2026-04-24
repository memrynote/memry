import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSync } from '@/contexts/sync-context'
import { invoke } from '@/lib/ipc/invoke'
import type { SyncHistoryEntry } from '@memry/contracts/ipc-sync-ops'

export type HistoryTypeFilter = 'all' | 'push' | 'pull' | 'error'
export type HistoryPeriodFilter = 'today' | '7d' | '30d' | 'all'

export interface SyncHistoryFilter {
  type: HistoryTypeFilter
  period: HistoryPeriodFilter
}

const PAGE_SIZE = 20
const FETCH_SIZE = 100

function getPeriodCutoff(period: HistoryPeriodFilter): number {
  if (period === 'all') return 0
  const now = Date.now()
  if (period === 'today') {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return start.getTime()
  }
  if (period === '7d') return now - 7 * 24 * 60 * 60 * 1000
  return now - 30 * 24 * 60 * 60 * 1000
}

function applyFilters(entries: SyncHistoryEntry[], filter: SyncHistoryFilter): SyncHistoryEntry[] {
  let filtered = entries.filter((e) => e.type === 'error' || e.itemCount > 0)
  if (filter.type !== 'all') {
    filtered = filtered.filter((e) => e.type === filter.type)
  }
  if (filter.period !== 'all') {
    const cutoff = getPeriodCutoff(filter.period)
    filtered = filtered.filter((e) => e.createdAt >= cutoff)
  }
  return filtered
}

export interface UseSyncHistoryReturn {
  entries: SyncHistoryEntry[]
  total: number
  isLoading: boolean
  hasMore: boolean
  filter: SyncHistoryFilter
  setFilter: (update: Partial<SyncHistoryFilter>) => void
  loadMore: () => void
  refresh: () => void
}

export function useSyncHistory(): UseSyncHistoryReturn {
  const { state } = useSync()
  const [allEntries, setAllEntries] = useState<SyncHistoryEntry[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [filter, setFilterState] = useState<SyncHistoryFilter>({ type: 'all', period: 'all' })
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const fetchedOffset = useRef(0)
  const lastSyncAtRef = useRef(state.lastSyncAt)

  const fetchEntries = useCallback(async (offset: number, append: boolean) => {
    setIsLoading(true)
    try {
      const result = await invoke<{ entries: unknown[]; total: number }>('sync_ops_get_history', {
        limit: FETCH_SIZE,
        offset
      })
      const entries = result.entries as unknown as SyncHistoryEntry[]
      if (append) {
        setAllEntries((prev) => [...prev, ...entries])
      } else {
        setAllEntries(entries)
      }
      setTotal(result.total)
      fetchedOffset.current = offset + entries.length
    } catch {
      // IPC failure — keep existing data
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchEntries(0, false)
  }, [fetchEntries])

  useEffect(() => {
    if (state.lastSyncAt && state.lastSyncAt !== lastSyncAtRef.current) {
      lastSyncAtRef.current = state.lastSyncAt
      setVisibleCount(PAGE_SIZE)
      void fetchEntries(0, false)
    }
  }, [state.lastSyncAt, fetchEntries])

  const filtered = useMemo(() => applyFilters(allEntries, filter), [allEntries, filter])

  const visibleEntries = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])

  const hasMore = visibleCount < filtered.length || fetchedOffset.current < total

  const loadMore = useCallback(() => {
    if (visibleCount < filtered.length) {
      setVisibleCount((prev) => prev + PAGE_SIZE)
      return
    }
    if (fetchedOffset.current < total) {
      void fetchEntries(fetchedOffset.current, true)
    }
  }, [visibleCount, filtered.length, total, fetchEntries])

  const setFilter = useCallback((update: Partial<SyncHistoryFilter>) => {
    setFilterState((prev) => ({ ...prev, ...update }))
    setVisibleCount(PAGE_SIZE)
  }, [])

  const refresh = useCallback(() => {
    setVisibleCount(PAGE_SIZE)
    void fetchEntries(0, false)
  }, [fetchEntries])

  return {
    entries: visibleEntries,
    total,
    isLoading,
    hasMore,
    filter,
    setFilter,
    loadMore,
    refresh
  }
}
