/**
 * Tab Bar With Overflow
 * Handles scrollable tabs with overflow indicators
 */

import { useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react'
import { ChevronLeft, ChevronRight } from '@/lib/icons'
import { useTabGroup } from '@/contexts/tabs'
import { cn } from '@/lib/utils'

interface TabBarWithOverflowProps {
  /** Group ID */
  groupId: string
  /** Children (tabs to render) */
  children: React.ReactNode
  /** Additional CSS classes */
  className?: string
}

interface OverflowState {
  left: boolean
  right: boolean
}

function getOverflowState(container: HTMLDivElement, tabs: HTMLDivElement): OverflowState {
  return {
    left: tabs.scrollLeft > 5,
    right: tabs.scrollLeft + container.clientWidth < tabs.scrollWidth - 5
  }
}

/**
 * Tab bar container with scroll overflow handling
 */
export const TabBarWithOverflow = ({
  groupId,
  children,
  className
}: TabBarWithOverflowProps): React.JSX.Element => {
  const group = useTabGroup(groupId)
  const containerRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  const [overflow, setOverflow] = useState({
    left: false,
    right: false
  })

  /**
   * Check for overflow state
   */
  const checkOverflow = useCallback(() => {
    const container = containerRef.current
    const tabs = tabsRef.current
    if (!container || !tabs) return

    const nextOverflow = getOverflowState(container, tabs)
    setOverflow((current) =>
      current.left === nextOverflow.left && current.right === nextOverflow.right
        ? current
        : nextOverflow
    )
  }, [])

  const observeNode = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || typeof ResizeObserver === 'undefined') return

      if (!resizeObserverRef.current) {
        resizeObserverRef.current = new ResizeObserver(() => {
          checkOverflow()
        })
      }

      resizeObserverRef.current.observe(node)
    },
    [checkOverflow]
  )

  const setContainerNode = useCallback(
    (node: HTMLDivElement | null) => {
      if (resizeObserverRef.current && containerRef.current) {
        resizeObserverRef.current.unobserve(containerRef.current)
      }

      containerRef.current = node
      observeNode(node)
      checkOverflow()
    },
    [checkOverflow, observeNode]
  )

  const setTabsNode = useCallback(
    (node: HTMLDivElement | null) => {
      if (resizeObserverRef.current && tabsRef.current) {
        resizeObserverRef.current.unobserve(tabsRef.current)
      }

      tabsRef.current = node
      observeNode(node)
      checkOverflow()
    },
    [checkOverflow, observeNode]
  )

  useEffect(() => {
    if (typeof ResizeObserver !== 'undefined') return

    // Fallback to window resize
    window.addEventListener('resize', checkOverflow)
    return () => window.removeEventListener('resize', checkOverflow)
  }, [checkOverflow])

  useEffect(() => {
    return () => {
      resizeObserverRef.current?.disconnect()
    }
  }, [])

  /**
   * Scroll tabs in direction
   */
  const scroll = useCallback(
    (direction: 'left' | 'right') => {
      if (!tabsRef.current) return

      const scrollAmount = direction === 'left' ? -150 : 150
      tabsRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' })

      // Recheck overflow after animation
      setTimeout(checkOverflow, 300)
    },
    [checkOverflow]
  )

  /**
   * Scroll active tab into view
   */
  useLayoutEffect(() => {
    if (!group?.activeTabId) return

    const activeTab = document.querySelector<HTMLElement>(
      `[data-tab-group="${groupId}"] [data-tab-id="${group.activeTabId}"]`
    )

    if (activeTab) {
      activeTab.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
      })
    }
  }, [group?.activeTabId, groupId])

  return (
    <div
      ref={setContainerNode}
      className={cn('flex items-center flex-1 overflow-hidden', className)}
    >
      {/* Left scroll button */}
      {overflow.left && (
        <button
          type="button"
          onClick={() => scroll('left')}
          className={cn(
            'flex-shrink-0 w-6 h-full flex items-center justify-center',
            'bg-gradient-to-r from-muted to-transparent',
            'hover:from-surface-active',
            'transition-colors'
          )}
          aria-label="Scroll tabs left"
        >
          <ChevronLeft className="w-4 h-4 text-text-tertiary" />
        </button>
      )}

      {/* Scrollable tabs container */}
      <div
        ref={setTabsNode}
        data-tab-group={groupId}
        className="flex-1 flex items-center overflow-x-auto scrollbar-none"
        onScroll={checkOverflow}
      >
        {children}
      </div>

      {/* Right scroll button */}
      {overflow.right && (
        <button
          type="button"
          onClick={() => scroll('right')}
          className={cn(
            'flex-shrink-0 w-6 h-full flex items-center justify-center',
            'bg-gradient-to-l from-muted to-transparent',
            'hover:from-surface-active',
            'transition-colors'
          )}
          aria-label="Scroll tabs right"
        >
          <ChevronRight className="w-4 h-4 text-text-tertiary" />
        </button>
      )}
    </div>
  )
}

export default TabBarWithOverflow
