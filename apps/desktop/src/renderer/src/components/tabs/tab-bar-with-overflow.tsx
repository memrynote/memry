/**
 * Tab Bar With Overflow
 * Handles scrollable tabs with overflow indicators
 */

import { useRef, useState, useCallback, useEffect } from 'react'
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

  const [overflow, setOverflow] = useState({
    left: false,
    right: false
  })

  /**
   * Check for overflow state
   */
  const checkOverflow = useCallback(() => {
    if (!containerRef.current || !tabsRef.current) return

    const container = containerRef.current
    const tabs = tabsRef.current

    setOverflow({
      left: tabs.scrollLeft > 5,
      right: tabs.scrollLeft + container.clientWidth < tabs.scrollWidth - 5
    })
  }, [])

  // Check overflow on mount and when tabs change
  useEffect(() => {
    checkOverflow()

    // Use ResizeObserver if available
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(checkOverflow)
      if (containerRef.current) observer.observe(containerRef.current)
      if (tabsRef.current) observer.observe(tabsRef.current)
      return () => observer.disconnect()
    }

    // Fallback to window resize
    window.addEventListener('resize', checkOverflow)
    return () => window.removeEventListener('resize', checkOverflow)
  }, [checkOverflow, group?.tabs.length])

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
  useEffect(() => {
    if (!tabsRef.current || !group?.activeTabId) return

    const activeTab = tabsRef.current.querySelector(`[data-tab-id="${group.activeTabId}"]`)

    if (activeTab) {
      activeTab.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
      })
    }
  }, [group?.activeTabId])

  return (
    <div ref={containerRef} className={cn('flex items-center flex-1 overflow-hidden', className)}>
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
        ref={tabsRef}
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
