/**
 * Reveal in Sidebar Hook
 * Handles "Reveal in Sidebar" events from tab context menu
 */

import { useEffect, useState, useCallback } from 'react'
import type { SidebarItem } from '@/contexts/tabs/types'

/**
 * Event detail for reveal-in-sidebar custom event
 */
interface RevealInSidebarDetail {
  path: string
  entityId?: string
}

/**
 * State for reveal in sidebar functionality
 */
interface RevealInSidebarState {
  /** Currently highlighted item ID */
  highlightedItemId: string | null
  /** Set highlighted item (auto-clears after delay) */
  setHighlightedItemId: (id: string | null) => void
  /** Find item by path or entityId */
  findItem: (path: string, entityId?: string) => SidebarItem | null
  /** Scroll an item into view */
  scrollToItem: (itemId: string) => void
}

/**
 * Hook for handling "Reveal in Sidebar" functionality
 * @param items - Flat or nested sidebar items to search
 * @param expandSection - Callback to expand collapsed sections
 */
export const useRevealInSidebar = (
  items: SidebarItem[],
  expandSection?: (sectionId: string) => void
): RevealInSidebarState => {
  const [highlightedItemId, setHighlightedItemIdState] = useState<string | null>(null)

  /**
   * Set highlighted item with auto-clear
   */
  const setHighlightedItemId = useCallback((id: string | null) => {
    setHighlightedItemIdState(id)

    if (id) {
      // Auto-clear highlight after 2 seconds
      setTimeout(() => {
        setHighlightedItemIdState((current) => (current === id ? null : current))
      }, 2000)
    }
  }, [])

  /**
   * Find item by path or entityId (recursive)
   */
  const findItem = useCallback(
    (path: string, entityId?: string): SidebarItem | null => {
      const search = (items: SidebarItem[]): SidebarItem | null => {
        for (const item of items) {
          // Match by entityId first (more specific)
          if (entityId && item.entityId === entityId) {
            return item
          }

          // Match by path
          if (item.path === path) {
            return item
          }

          // Search children
          if (item.children) {
            const found = search(item.children)
            if (found) return found
          }
        }
        return null
      }

      return search(items)
    },
    [items]
  )

  /**
   * Scroll an item into view
   */
  const scrollToItem = useCallback((itemId: string) => {
    const element = document.querySelector(`[data-item-id="${itemId}"]`)
    if (element) {
      element.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      })
    }
  }, [])

  /**
   * Handle reveal-in-sidebar event
   */
  useEffect(() => {
    const handleReveal = (event: CustomEvent<RevealInSidebarDetail>) => {
      const { path, entityId } = event.detail

      // Find matching item
      const item = findItem(path, entityId)

      if (item) {
        // Expand parent sections if needed
        if (expandSection && item.type) {
          // Determine section based on type
          if (['project'].includes(item.type)) {
            expandSection('projects')
          } else if (['collection'].includes(item.type)) {
            expandSection('collections')
          } else if (['note', 'journal'].includes(item.type)) {
            expandSection('notes')
          }
        }

        // Scroll into view
        scrollToItem(item.id ?? '')

        // Highlight briefly
        setHighlightedItemId(item.id ?? null)
      }
    }

    window.addEventListener('reveal-in-sidebar', handleReveal as EventListener)

    return () => {
      window.removeEventListener('reveal-in-sidebar', handleReveal as EventListener)
    }
  }, [findItem, scrollToItem, setHighlightedItemId, expandSection])

  return {
    highlightedItemId,
    setHighlightedItemId,
    findItem,
    scrollToItem
  }
}

export default useRevealInSidebar
