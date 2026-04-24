/**
 * Optimized hook for checking if a sidebar item is active
 *
 * PERFORMANCE: This hook is critical for sidebar performance because:
 * 1. Every sidebar item calls isActiveItem during render
 * 2. The old implementation depended on full state, causing all items to re-render
 * 3. This version tracks only the active tab identity (type, entityId, path)
 * 4. Returns a stable callback that doesn't cause re-renders
 *
 * The key insight is that we only need to know WHAT is active, not the full state.
 * By tracking just the identity fields, we minimize the re-render trigger surface.
 */

import { useCallback, useRef, useEffect, useMemo } from 'react'
import { useTabs } from '@/contexts/tabs'
import { SINGLETON_TAB_TYPES } from '@/contexts/tabs/types'
import type { SidebarItem } from '@/contexts/tabs/types'

/**
 * Minimal identity of the active tab - only what's needed for comparison
 */
interface ActiveTabIdentity {
  type: string
  entityId: string
  path: string
}

/**
 * Hook that provides an optimized isActiveItem function
 *
 * Returns a stable callback that checks if a sidebar item matches the active tab.
 * The callback itself doesn't change (stable reference), but uses refs internally
 * to always access the current active tab identity.
 */
export const useIsItemActive = () => {
  const { state } = useTabs()

  // Extract only what we need from the active tab
  // This computation happens on every state change, but it's cheap
  const activeTabIdentity = useMemo((): ActiveTabIdentity | null => {
    const group = state.tabGroups[state.activeGroupId]
    if (!group || !group.activeTabId) return null

    const activeTab = group.tabs.find((t) => t.id === group.activeTabId)
    if (!activeTab) return null

    return {
      type: activeTab.type,
      entityId: activeTab.entityId ?? '',
      path: activeTab.path ?? ''
    }
  }, [state.tabGroups, state.activeGroupId])

  // Store identity in ref for stable callback access
  const identityRef = useRef<ActiveTabIdentity | null>(activeTabIdentity)

  // Keep ref in sync (runs after render, before effects)
  useEffect(() => {
    identityRef.current = activeTabIdentity
  })

  // Return stable callback that reads from ref
  // This callback NEVER changes reference, preventing cascade re-renders
  const isActiveItem = useCallback((item: SidebarItem): boolean => {
    const identity = identityRef.current
    if (!identity) return false

    // For singletons (inbox, journal, tasks), match by type only
    if (SINGLETON_TAB_TYPES.includes(item.type)) {
      return identity.type === item.type
    }

    // For content items (notes, files), match by entityId
    if (item.entityId) {
      return identity.entityId === item.entityId
    }

    // Fallback to path match
    return identity.path === (item.path ?? '')
  }, [])

  return isActiveItem
}

export default useIsItemActive
