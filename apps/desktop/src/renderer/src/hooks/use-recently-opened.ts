/**
 * Recently Opened Hooks
 *
 * The trail is device-local (see the `recently_opened` table) and written from
 * the renderer, because only the renderer knows when a tab actually became the
 * one you are looking at. `note_opened` telemetry cannot stand in for it: that
 * fires on every `notes:get`, including react-query refetches after a save or
 * a peer sync.
 *
 * @module hooks/use-recently-opened
 */

import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RecentlyOpenedItem, RecentlyOpenedItemType } from '@memry/contracts/recents-api'
// Via the barrel, not '@/contexts/tabs/context': App-level suites mock the
// barrel, and reaching past it makes this hook demand a real TabProvider they
// do not build.
import { useActiveTab } from '@/contexts/tabs'

export const recentlyOpenedKeys = {
  all: ['recently-opened'] as const,
  list: (limit: number) => ['recently-opened', limit] as const
}

/** Time an item must stay in front before it counts as opened. */
const DWELL_MS = 2000
/** Re-opening the same item inside this window does not write again. */
const THROTTLE_MS = 60_000

export function useRecentlyOpened(limit: number): {
  items: RecentlyOpenedItem[]
  isLoading: boolean
  error: unknown
} {
  const query = useQuery({
    queryKey: recentlyOpenedKeys.list(limit),
    queryFn: () => window.api.recents.list(limit) as Promise<RecentlyOpenedItem[]>,
    staleTime: 30_000
  })

  return {
    items: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error
  }
}

/**
 * Records the active note or canvas tab once it has been in front for
 * {@link DWELL_MS}. Mount once, high in the tree, inside TabProvider.
 */
export function useRecordRecentlyOpened(): void {
  const activeTab = useActiveTab()
  const queryClient = useQueryClient()
  const lastWriteRef = useRef<Map<string, number>>(new Map())

  // Canvases live in the same tab bar and are just as much "something you
  // opened"; a tab type the trail cannot resolve is skipped instead.
  const itemType: RecentlyOpenedItemType | null =
    activeTab?.type === 'note' || activeTab?.type === 'canvas' ? activeTab.type : null
  const itemId = itemType ? (activeTab?.entityId ?? null) : null

  useEffect(() => {
    if (!itemType || !itemId) return

    // Tab-switching past an item should not enter the trail, so wait out the
    // dwell before writing; unmounting the effect cancels it.
    const timer = setTimeout(() => {
      // Keyed by type as well as id: the trail's unique index is
      // (item_type, item_id), so a note and a canvas throttle separately.
      const key = `${itemType}:${itemId}`
      const now = Date.now()
      const last = lastWriteRef.current.get(key)
      if (last !== undefined && now - last < THROTTLE_MS) return
      lastWriteRef.current.set(key, now)

      void Promise.resolve(window.api.recents.record({ itemId, itemType })).then(() =>
        queryClient.invalidateQueries({ queryKey: recentlyOpenedKeys.all })
      )
    }, DWELL_MS)

    return () => clearTimeout(timer)
  }, [itemType, itemId, queryClient])
}
