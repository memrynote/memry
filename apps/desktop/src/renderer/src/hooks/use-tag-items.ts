/**
 * Placeholder for the single-tag items query.
 *
 * Task 14 (this shell) only needs the module and shape to exist so
 * `TagViewPage`'s header can render a count. Task 15 replaces this body
 * wholesale with the real backend-backed query (items for the tag, paged,
 * sorted, etc.) — do not build on top of this static return.
 */
import { useCallback } from 'react'

export interface UseTagItemsResult {
  items: unknown[]
  total: number
  isLoading: boolean
  error: string | null
  refresh: () => void
}

export function useTagItems(tag: string): UseTagItemsResult {
  void tag

  const refresh = useCallback(() => {}, [])

  return {
    items: [],
    total: 0,
    isLoading: false,
    error: null,
    refresh
  }
}
