/**
 * Tab Bar with Drag Support
 * Tab bar container with drag-to-reorder functionality
 * Uses parent DndContext from SplitViewContainer for cross-panel dragging
 */

import { useRef, useState, useLayoutEffect, useCallback } from 'react'
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable'
import { ChevronLeft, ChevronRight, LayoutAlignRightIcon } from '@/lib/icons'
import { useDayPanel } from '@/contexts/day-panel-context'
import { useTabGroup } from '@/contexts/tabs'
import { useSidebar } from '@/components/ui/sidebar'
import { SortableTab } from './sortable-tab'
import { PinnedTab } from './pinned-tab'
import { TabBarAction } from './tab-bar-action'
import { NewTabMenu } from './new-tab-menu'
import { TabBarContextMenu } from './tab-bar-context-menu'
import { TabContextMenu } from './tab-context-menu'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

interface TabBarWithDragProps {
  /** ID of the tab group to display */
  groupId: string
  /** Whether to show the sidebar collapse toggle (hidden in split panes) */
  showSidebarToggle?: boolean
  /** Whether this tab bar should reserve space for the fixed day panel */
  reserveDayPanelSpace?: boolean
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
  reserveDayPanelSpace = true,
  className
}: TabBarWithDragProps): React.JSX.Element | null => {
  const { t: tPhaseF } = useT('common')
  const group = useTabGroup(groupId)
  const {
    toggle: toggleDayPanel,
    isOpen: isDayPanelOpen,
    width: dayPanelWidth,
    isResizing: isDayPanelResizing
  } = useDayPanel()
  const { state: sidebarState } = useSidebar()
  const needsChromeSpacer = sidebarState === 'collapsed' && showSidebarToggle
  const shouldReserveDayPanelSpace = reserveDayPanelSpace && isDayPanelOpen

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
  useLayoutEffect(() => {
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
          'drag-region flex items-end shrink-0',
          'bg-transparent',
          'relative',
          'border-b border-border',
          isDayPanelResizing
            ? 'transition-[padding-inline-start] duration-200 ease-linear'
            : 'transition-[padding-inline-start,margin-inline-end] duration-200 ease-linear',
          needsChromeSpacer && 'ps-[var(--chrome-width)]',
          className
        )}
        style={{ marginInlineEnd: shouldReserveDayPanelSpace ? `${dayPanelWidth}px` : 0 }}
        role="tablist"
        aria-label={tPhaseF('phaseF.componentsTabsTabBarWithDrag.openTabs')}
        aria-orientation="horizontal"
        data-group-id={groupId}
      >
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
              'absolute start-0 bottom-px'
            )}
            aria-label={tPhaseF('phaseF.componentsTabsTabBarWithDrag.scrollTabsLeft')}
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
            canScrollLeft && 'ps-7',
            canScrollRight && 'pe-7'
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
              isDayPanelOpen ? 'absolute end-0 bottom-px' : 'absolute end-[48px] bottom-px'
            )}
            aria-label={tPhaseF('phaseF.componentsTabsTabBarWithDrag.scrollTabsRight')}
          >
            <ChevronRight className="w-3.5 h-3.5 text-text-tertiary hover:text-foreground transition-colors" />
          </button>
        )}

        {/* Tab actions */}
        {!isDayPanelOpen && (
          <div className="no-drag ms-auto flex items-center gap-1 self-center pe-[13px] ps-2">
            <TabBarAction
              icon={<LayoutAlignRightIcon className="w-4 h-4 transition-colors duration-150" />}
              tooltip={tPhaseF('phaseF.componentsTabsTabBarWithDrag.dayPanel')}
              onClick={toggleDayPanel}
            />
          </div>
        )}
      </div>
    </TabBarContextMenu>
  )
}

export default TabBarWithDrag
