/**
 * Tab Bar Component
 * Main container for tabs with scroll handling and actions
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useTabGroup, useTabs } from '@/contexts/tabs'
import { RegularTab } from './regular-tab'
import { PinnedTab } from './pinned-tab'
import { TabBarAction } from './tab-bar-action'
import { cn } from '@/lib/utils'

interface TabBarProps {
  /** ID of the tab group to display */
  groupId: string
  /** Additional CSS classes */
  className?: string
}

/**
 * Tab bar component with pinned tabs, regular tabs, and action buttons
 */
export const TabBar = ({ groupId, className }: TabBarProps): React.JSX.Element | null => {
  const { state, openTab } = useTabs()
  const group = useTabGroup(groupId)

  // Scroll state
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const checkScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current
    setCanScrollLeft(scrollLeft > 0)
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1)
  }, [])

  const regularTabCount = group?.tabs.filter((t) => !t.isPinned).length ?? 0

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    checkScroll()

    el.addEventListener('scroll', checkScroll, { passive: true })

    const resizeObserver = new ResizeObserver(checkScroll)
    resizeObserver.observe(el)

    return () => {
      el.removeEventListener('scroll', checkScroll)
      resizeObserver.disconnect()
    }
  }, [checkScroll, regularTabCount])

  if (!group) return null

  const pinnedTabs = group.tabs.filter((t) => t.isPinned)
  const regularTabs = group.tabs.filter((t) => !t.isPinned)
  const isActiveGroup = state.activeGroupId === groupId

  const scrollLeft = (): void => {
    if (!scrollRef.current) return
    scrollRef.current.scrollBy({ left: -200, behavior: 'smooth' })
  }

  const scrollRight = (): void => {
    if (!scrollRef.current) return
    scrollRef.current.scrollBy({ left: 200, behavior: 'smooth' })
  }

  // Handle new tab
  const handleNewTab = (): void => {
    openTab(
      {
        type: 'inbox',
        title: 'Inbox',
        icon: 'inbox',
        path: '/inbox',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      },
      { groupId }
    )
  }

  return (
    <div
      className={cn(
        // Container
        'flex items-center h-9',
        'bg-gray-50 dark:bg-gray-900',
        'border-b border-gray-200 dark:border-gray-700',
        // Active group indicator
        isActiveGroup && 'bg-gray-100/50 dark:bg-gray-800/50',
        className
      )}
      role="tablist"
      aria-label="Open tabs"
      aria-orientation="horizontal"
      data-group-id={groupId}
    >
      {/* Pinned tabs section */}
      {pinnedTabs.length > 0 && (
        <>
          <div className="flex items-center px-1 gap-0.5">
            {pinnedTabs.map((tab) => (
              <PinnedTab
                key={tab.id}
                tab={tab}
                groupId={groupId}
                isActive={tab.id === group.activeTabId}
              />
            ))}
          </div>

          {/* Divider between pinned and regular tabs */}
          <div className="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1" />
        </>
      )}

      {/* Scroll left button */}
      {canScrollLeft && (
        <button
          type="button"
          onClick={scrollLeft}
          className={cn(
            'flex items-center justify-center',
            'w-6 h-9',
            'bg-gradient-to-r from-gray-50 to-transparent',
            'dark:from-gray-900 dark:to-transparent',
            'hover:from-gray-100 dark:hover:from-gray-800',
            'transition-colors z-10'
          )}
          aria-label="Scroll tabs left"
        >
          <ChevronLeft className="w-4 h-4 text-gray-500" />
        </button>
      )}

      {/* Regular tabs section (scrollable) */}
      <div
        ref={scrollRef}
        className={cn(
          'flex-1 flex items-center',
          'overflow-x-auto',
          // Hide scrollbar
          'scrollbar-none',
          '[&::-webkit-scrollbar]:hidden',
          '[-ms-overflow-style:none]',
          '[scrollbar-width:none]'
        )}
      >
        <div className="flex items-center">
          {regularTabs.map((tab) => (
            <RegularTab
              key={tab.id}
              tab={tab}
              groupId={groupId}
              isActive={tab.id === group.activeTabId}
            />
          ))}
        </div>
      </div>

      {/* Scroll right button */}
      {canScrollRight && (
        <button
          type="button"
          onClick={scrollRight}
          className={cn(
            'flex items-center justify-center',
            'w-6 h-9',
            'bg-gradient-to-l from-gray-50 to-transparent',
            'dark:from-gray-900 dark:to-transparent',
            'hover:from-gray-100 dark:hover:from-gray-800',
            'transition-colors z-10'
          )}
          aria-label="Scroll tabs right"
        >
          <ChevronRight className="w-4 h-4 text-gray-500" />
        </button>
      )}

      {/* Tab actions */}
      <div className="flex items-center px-1 gap-0.5 border-l border-gray-200 dark:border-gray-700">
        <TabBarAction
          icon={<Plus className="w-4 h-4" />}
          tooltip="New Tab"
          onClick={handleNewTab}
        />
      </div>
    </div>
  )
}

export default TabBar
