/**
 * Tab Bar with Drag Support
 * Tab bar container with drag-to-reorder functionality
 * Uses parent DndContext from SplitViewContainer for cross-panel dragging
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable'
import { ChevronLeft, ChevronRight, Bot } from 'lucide-react'
import { useAIAgent } from '@/contexts/ai-agent-context'
import { useTabGroup } from '@/contexts/tabs'
import { SortableTab } from './sortable-tab'
import { PinnedTab } from './pinned-tab'
import { TabBarAction } from './tab-bar-action'
import { TabBarContextMenu } from './tab-bar-context-menu'
import { TabContextMenu } from './tab-context-menu'
import { cn } from '@/lib/utils'

interface TabBarWithDragProps {
  /** ID of the tab group to display */
  groupId: string
  /** Additional CSS classes */
  className?: string
}

/**
 * Tab bar with drag-to-reorder support and context menu
 * DndContext is provided by SplitViewContainer for cross-panel support
 */
export const TabBarWithDrag = ({
  groupId,
  className
}: TabBarWithDragProps): React.JSX.Element | null => {
  const group = useTabGroup(groupId)
  const { toggle: toggleAIAgent, isOpen: isAIAgentOpen } = useAIAgent()

  // Scroll state
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  // If group doesn't exist, don't render
  if (!group) return null

  // Separate pinned and regular tabs
  const pinnedTabs = group.tabs.filter((t) => t.isPinned)
  const regularTabs = group.tabs.filter((t) => !t.isPinned)

  // Check scroll state
  const checkScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current
    setCanScrollLeft(scrollLeft > 0)
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1)
  }, [])

  // Set up scroll listener
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    checkScroll()
    el.addEventListener('scroll', checkScroll)

    const resizeObserver = new ResizeObserver(checkScroll)
    resizeObserver.observe(el)

    return () => {
      el.removeEventListener('scroll', checkScroll)
      resizeObserver.disconnect()
    }
  }, [checkScroll, regularTabs.length])

  // Scroll handlers
  const scrollLeft = (): void => {
    scrollRef.current?.scrollBy({ left: -200, behavior: 'smooth' })
  }

  const scrollRight = (): void => {
    scrollRef.current?.scrollBy({ left: 200, behavior: 'smooth' })
  }

  return (
    <TabBarContextMenu groupId={groupId}>
      <div
        className={cn(
          // Container - align items to bottom for tab merge effect
          'flex items-end h-full',
          'bg-transparent',
          'relative',
          // Bottom border that active tabs will overlap
          'border-b border-gray-200 dark:border-gray-700',
          className
        )}
        role="tablist"
        aria-label="Open tabs"
        aria-orientation="horizontal"
        data-group-id={groupId}
      >
        {/* Pinned tabs section (not in sortable context) */}
        {pinnedTabs.length > 0 && (
          <>
            <div className="flex items-end px-1.5 gap-0.5 pb-0">
              {pinnedTabs.map((tab) => (
                <TabContextMenu key={tab.id} tab={tab} groupId={groupId}>
                  <PinnedTab tab={tab} groupId={groupId} isActive={tab.id === group.activeTabId} />
                </TabContextMenu>
              ))}
            </div>

            {/* Divider */}
            <div className="w-px h-5 bg-gray-200 dark:bg-gray-700 mx-1 mb-2" />
          </>
        )}

        {/* Scroll left button */}
        {canScrollLeft && (
          <button
            type="button"
            onClick={scrollLeft}
            className={cn(
              'flex items-center justify-center w-7 h-[calc(100%-4px)]',
              'bg-gradient-to-r from-gray-100/95 via-gray-100/70 to-transparent',
              'dark:from-gray-800/95 dark:via-gray-800/70 dark:to-transparent',
              'hover:from-gray-200/95 dark:hover:from-gray-700/95',
              'transition-all duration-150 ease-out z-20',
              'absolute left-0 bottom-px'
            )}
            aria-label="Scroll tabs left"
          >
            <ChevronLeft className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors" />
          </button>
        )}

        {/* Regular tabs section (sortable) */}
        <div
          ref={scrollRef}
          className={cn(
            'flex-1 flex items-end overflow-x-auto',
            'scroll-smooth',
            'scrollbar-none [&::-webkit-scrollbar]:hidden',
            '[-ms-overflow-style:none] [scrollbar-width:none]',
            canScrollLeft && 'pl-7',
            canScrollRight && 'pr-7'
          )}
        >
          <SortableContext
            items={regularTabs.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex items-end gap-0.5 px-1 pb-0">
              {regularTabs.map((tab) => (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  groupId={groupId}
                  isActive={tab.id === group.activeTabId}
                />
              ))}
            </div>
          </SortableContext>
        </div>

        {/* Scroll right button */}
        {canScrollRight && (
          <button
            type="button"
            onClick={scrollRight}
            className={cn(
              'flex items-center justify-center w-7 h-[calc(100%-4px)]',
              'bg-gradient-to-l from-gray-100/95 via-gray-100/70 to-transparent',
              'dark:from-gray-800/95 dark:via-gray-800/70 dark:to-transparent',
              'hover:from-gray-200/95 dark:hover:from-gray-700/95',
              'transition-all duration-150 ease-out z-20',
              'absolute right-[72px] bottom-px'
            )}
            aria-label="Scroll tabs right"
          >
            <ChevronRight className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors" />
          </button>
        )}

        {/* Tab actions */}
        <div className="flex items-center px-2 gap-1 mb-1.5 ml-auto self-center">
          <TabBarAction
            icon={
              <Bot
                className={cn(
                  'w-4 h-4 transition-colors duration-150',
                  isAIAgentOpen && 'text-blue-500 dark:text-blue-400'
                )}
              />
            }
            tooltip="AI Agent"
            onClick={toggleAIAgent}
          />
        </div>
      </div>
    </TabBarContextMenu>
  )
}

export default TabBarWithDrag
