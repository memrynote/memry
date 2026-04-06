/**
 * Tab Bar with Drag Support
 * Tab bar container with drag-to-reorder functionality
 * Uses parent DndContext from SplitViewContainer for cross-panel dragging
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable'
import { ChevronLeft, ChevronRight, Calendar } from '@/lib/icons'
import { SidebarGraph } from '@/lib/icons/sidebar-nav-icons'
import { useDayPanel } from '@/contexts/day-panel-context'
import { useTabGroup, useTabs } from '@/contexts/tabs'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { SortableTab } from './sortable-tab'
import { PinnedTab } from './pinned-tab'
import { TabBarAction } from './tab-bar-action'
import { NewTabMenu } from './new-tab-menu'
import { TabBarContextMenu } from './tab-bar-context-menu'
import { TabContextMenu } from './tab-context-menu'
import { cn } from '@/lib/utils'

interface TabBarWithDragProps {
  /** ID of the tab group to display */
  groupId: string
  /** Whether to show the sidebar collapse toggle (hidden in split panes) */
  showSidebarToggle?: boolean
  /** Additional CSS classes */
  className?: string
}

/**
 * Tab bar with drag-to-reorder support and context menu
 * DndContext is provided by SplitViewContainer for cross-panel support
 */
export const TabBarWithDrag = ({
  groupId,
  showSidebarToggle = true,
  className
}: TabBarWithDragProps): React.JSX.Element | null => {
  const group = useTabGroup(groupId)
  const { toggle: toggleDayPanel, isOpen: isDayPanelOpen } = useDayPanel()
  const { openTab, getActiveTab } = useTabs()

  const isGraphActive = getActiveTab()?.type === 'graph'

  const handleGraphClick = useCallback(() => {
    openTab({
      type: 'graph',
      title: 'Graph',
      icon: 'graph',
      path: '/graph',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
  }, [openTab])

  // Scroll state
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  // Check scroll state - must be before early return (rules of hooks)
  const checkScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current
    setCanScrollLeft(scrollLeft > 0)
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1)
  }, [])

  // Compute tabs length safely before early return for useEffect dependency
  const regularTabsLength = group?.tabs.filter((t) => !t.isPinned).length ?? 0

  // Set up scroll listener - must be before early return (rules of hooks)
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
  }, [checkScroll, regularTabsLength])

  // If group doesn't exist, don't render (after all hooks)
  if (!group) return null

  // Separate pinned and regular tabs
  const pinnedTabs = group.tabs.filter((t) => t.isPinned)
  const regularTabs = group.tabs.filter((t) => !t.isPinned)

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
          'drag-region flex items-end shrink-0',
          'bg-transparent',
          'relative',
          // Bottom border that active tabs will overlap
          'border-b border-border',
          className
        )}
        role="tablist"
        aria-label="Open tabs"
        aria-orientation="horizontal"
        data-group-id={groupId}
      >
        {showSidebarToggle && (
          <div className="no-drag flex items-center px-2 self-center">
            <SidebarTrigger className="text-text-tertiary hover:text-foreground transition-colors duration-150" />
          </div>
        )}

        {/* Pinned tabs section (not in sortable context) */}
        {pinnedTabs.length > 0 && (
          <>
            <div className="no-drag flex items-end px-1.5 gap-0.5 pb-0">
              {pinnedTabs.map((tab) => (
                <TabContextMenu key={tab.id} tab={tab} groupId={groupId}>
                  <PinnedTab tab={tab} groupId={groupId} isActive={tab.id === group.activeTabId} />
                </TabContextMenu>
              ))}
            </div>

            {/* Divider */}
            <div className="w-px h-5 bg-border mx-1 mb-2" />
          </>
        )}

        {/* Scroll left button */}
        {canScrollLeft && (
          <button
            type="button"
            onClick={scrollLeft}
            className={cn(
              'no-drag',
              'flex items-center justify-center w-7 h-[calc(100%-4px)]',
              'bg-gradient-to-r from-muted/95 via-muted/70 to-transparent',
              'hover:from-surface-active/95',
              'transition-all duration-150 ease-out z-20',
              'absolute left-0 bottom-px'
            )}
            aria-label="Scroll tabs left"
          >
            <ChevronLeft className="w-3.5 h-3.5 text-text-tertiary hover:text-foreground transition-colors" />
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
            <div className="no-drag flex items-end gap-0.5 px-1 pb-0">
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

          {/* New tab — inline after last tab, Chrome-style */}
          <div className="no-drag flex items-center shrink-0 px-1 self-center">
            <NewTabMenu groupId={groupId} />
          </div>
        </div>

        {/* Scroll right button */}
        {canScrollRight && (
          <button
            type="button"
            onClick={scrollRight}
            className={cn(
              'no-drag',
              'flex items-center justify-center w-7 h-[calc(100%-4px)]',
              'bg-gradient-to-l from-muted/95 via-muted/70 to-transparent',
              'hover:from-surface-active/95',
              'transition-all duration-150 ease-out z-20',
              'absolute right-[72px] bottom-px'
            )}
            aria-label="Scroll tabs right"
          >
            <ChevronRight className="w-3.5 h-3.5 text-text-tertiary hover:text-foreground transition-colors" />
          </button>
        )}

        {/* Tab actions */}
        <div
          className={cn(
            'no-drag flex items-center pr-[13px] pl-2 gap-1 ml-auto',
            isDayPanelOpen
              ? 'self-stretch bg-sidebar border-l border-sidebar-border rounded-tl-md relative z-10 mb-[-1px] pb-px'
              : 'self-center'
          )}
        >
          <TabBarAction
            icon={
              <SidebarGraph
                className={cn(
                  'w-4 h-4 transition-colors duration-150',
                  isGraphActive && 'text-tint'
                )}
              />
            }
            tooltip="Graph (⌘G)"
            onClick={handleGraphClick}
          />
          <TabBarAction
            icon={
              <Calendar
                className={cn(
                  'w-4 h-4 transition-colors duration-150',
                  isDayPanelOpen && 'text-tint'
                )}
              />
            }
            tooltip="Day Panel"
            onClick={toggleDayPanel}
            isActive={isDayPanelOpen}
          />
        </div>
      </div>
    </TabBarContextMenu>
  )
}

export default TabBarWithDrag
