/**
 * Tab Bar with Drag Support
 * Tab bar container with drag-to-reorder functionality
 * Uses parent DndContext from SplitViewContainer for cross-panel dragging
 */

import { useRef, useState, useLayoutEffect, useCallback } from 'react'
import { useDndContext } from '@dnd-kit/core'
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
  /** Whether this tab bar is the top-right one that shows the day-panel toggle */
  showDayPanelToggle?: boolean
  /** Additional CSS classes */
  className?: string
}

/** Vertical wheel scrolls the strip horizontally, like Chrome */
const handleWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
  e.currentTarget.scrollLeft += e.deltaY
}

/**
 * Tab bar with drag-to-reorder support and context menu
 * DndContext is provided by SplitViewContainer for cross-panel support
 */
export const TabBarWithDrag = ({
  groupId,
  showSidebarToggle = true,
  reserveDayPanelSpace = true,
  showDayPanelToggle = true,
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
  // Only the top-right tab bar shows the day-panel toggle (and reserves room for it)
  const showDayPanelToggleButton = !isDayPanelOpen && showDayPanelToggle

  // Scroll state — "start"/"end" are logical, so the math holds in RTL where
  // scrollLeft counts down from 0
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollToStart, setCanScrollToStart] = useState(false)
  const [canScrollToEnd, setCanScrollToEnd] = useState(false)
  const isOverflowing = canScrollToStart || canScrollToEnd

  // A tab being dragged owns the scroll position — dnd-kit runs its own autoscroll
  const { active: activeDragItem } = useDndContext()

  // Check scroll state - must be before early return (rules of hooks)
  const checkScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current
    const offset = Math.abs(scrollLeft)
    setCanScrollToStart(offset > 1)
    setCanScrollToEnd(offset + clientWidth < scrollWidth - 1)
  }, [])

  // Compute tabs length safely before early return for useEffect dependency
  const regularTabsLength = group?.tabs.filter((t) => !t.isPinned).length ?? 0
  const activeTabId = group?.activeTabId ?? null

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

  // Keep the active tab visible — without this the strip stays pinned at the start
  // and a newly opened (or newly activated) tab sits past the end edge.
  // Re-runs on the chevron gutters too: they widen the scroll content one render
  // after the scroll fires, which would push the tab back out of view.
  useLayoutEffect(() => {
    if (!activeTabId || activeDragItem) return
    const tabEl = scrollRef.current?.querySelector(`[data-tab-id="${CSS.escape(activeTabId)}"]`)
    // scrollIntoView is not implemented in jsdom
    tabEl?.scrollIntoView?.({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
  }, [activeTabId, regularTabsLength, activeDragItem, canScrollToStart, canScrollToEnd])

  // If group doesn't exist, don't render (after all hooks)
  if (!group) return null

  // Separate pinned and regular tabs
  const pinnedTabs = group.tabs.filter((t) => t.isPinned)
  const regularTabs = group.tabs.filter((t) => !t.isPinned)

  // Scroll handlers — scrollLeft runs negative in RTL, so flip the delta with the direction
  const scrollByLogical = (distance: number): void => {
    const el = scrollRef.current
    if (!el) return
    const sign = getComputedStyle(el).direction === 'rtl' ? -1 : 1
    el.scrollBy({ left: distance * sign, behavior: 'smooth' })
  }

  const scrollToStart = (): void => scrollByLogical(-200)
  const scrollToEnd = (): void => scrollByLogical(200)

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

        {/* Scroll to start button */}
        {canScrollToStart && (
          <button
            type="button"
            onClick={scrollToStart}
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
            <ChevronLeft className="w-3.5 h-3.5 text-text-tertiary hover:text-foreground transition-colors rtl:rotate-180" />
          </button>
        )}

        {/* Regular tabs section (sortable) — tabs are direct flex children so they
            share the strip evenly and overflow it once they hit their min width */}
        <div
          ref={scrollRef}
          onWheel={handleWheel}
          data-testid="tab-strip"
          className={cn(
            'flex-1 flex items-end gap-0.5 px-1 pb-0 overflow-x-auto',
            'scroll-smooth',
            'scrollbar-none [&::-webkit-scrollbar]:hidden',
            '[-ms-overflow-style:none] [scrollbar-width:none]',
            canScrollToStart && 'ps-7',
            canScrollToEnd && 'pe-7'
          )}
        >
          <SortableContext
            items={regularTabs.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            {regularTabs.map((tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                groupId={groupId}
                isActive={tab.id === group.activeTabId}
              />
            ))}
          </SortableContext>

          {/* New tab — inline after last tab, Chrome-style. Once the strip overflows
              it is pinned outside the scroller instead, so it stays reachable. */}
          {!isOverflowing && (
            <div className="no-drag flex items-center shrink-0 px-1 self-center">
              <NewTabMenu groupId={groupId} />
            </div>
          )}
        </div>

        {/* Scroll to end button */}
        {canScrollToEnd && (
          <button
            type="button"
            onClick={scrollToEnd}
            className={cn(
              'no-drag',
              'flex items-center justify-center w-7 h-[calc(100%-4px)]',
              'bg-gradient-to-l from-muted/95 via-muted/70 to-transparent',
              'hover:from-surface-active/95',
              'transition-all duration-150 ease-out z-20',
              // Clears the pinned new-tab button (36px), plus the day-panel toggle (48px)
              showDayPanelToggleButton
                ? 'absolute end-[84px] bottom-px'
                : 'absolute end-[36px] bottom-px'
            )}
            aria-label={tPhaseF('phaseF.componentsTabsTabBarWithDrag.scrollTabsRight')}
          >
            <ChevronRight className="w-3.5 h-3.5 text-text-tertiary hover:text-foreground transition-colors rtl:rotate-180" />
          </button>
        )}

        {/* New tab — pinned past the scroller while the strip overflows */}
        {isOverflowing && (
          <div className="no-drag flex items-center shrink-0 px-1 self-center">
            <NewTabMenu groupId={groupId} />
          </div>
        )}

        {/* Tab actions */}
        {showDayPanelToggleButton && (
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
