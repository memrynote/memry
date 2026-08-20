/**
 * Tab Bar with Drag Support
 * Tab bar container with drag-to-reorder functionality
 * Uses parent DndContext from SplitViewContainer for cross-panel dragging
 */

import { useRef, useState, useLayoutEffect, useCallback } from 'react'
import { AnimatePresence, LazyMotion, domAnimation, m, useReducedMotion } from 'motion/react'
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
 * Motion preference for the strip's own programmatic scrolls.
 *
 * A `behavior` passed in the scroll options overrides the CSS `scroll-behavior`
 * property, so the `@media (prefers-reduced-motion: reduce)` blocks in
 * `assets/base.css` cannot suppress these calls — the preference has to be read
 * in JS (same read as `components/onboarding/use-first-run-tour.ts`). Read at
 * call time rather than through a subscription: nothing renders from it, and a
 * mid-session change to the OS setting is picked up by the next scroll.
 */
const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'

/**
 * Is the tab already fully inside the strip's visible area?
 * The chevron gutters are inline padding on the strip, so they are subtracted —
 * a tab sitting under a chevron does not count as visible. Physical sides are
 * used because that is what the rects report in both LTR and RTL.
 */
const isTabFullyVisible = (strip: HTMLElement, tabEl: Element): boolean => {
  const stripRect = strip.getBoundingClientRect()
  const tabRect = tabEl.getBoundingClientRect()
  const style = getComputedStyle(strip)
  const visibleLeft = stripRect.left + (parseFloat(style.paddingLeft) || 0)
  const visibleRight = stripRect.right - (parseFloat(style.paddingRight) || 0)
  return tabRect.left >= visibleLeft - 1 && tabRect.right <= visibleRight + 1
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

  // Tab enter/exit animation (#1368 deleted the never-wired variants; this is
  // the wired version). Kept fast so the strip never feels laggy, and skipped
  // entirely under prefers-reduced-motion.
  const prefersReducedMotion = useReducedMotion()
  const tabEnterTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.16, ease: 'easeOut' as const }
  const tabExitTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.13, ease: 'easeIn' as const }
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
  // after the scroll fires, which would push the tab back out of view. Those
  // follow-up runs used to fire a second and third smooth scrollIntoView for the
  // same activation, restarting the animation mid-flight; they now only re-scroll
  // when the resized gutters actually pushed the tab out of the strip.
  const scrolledTabIdRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!activeTabId || activeDragItem) return
    const strip = scrollRef.current
    const tabEl = strip?.querySelector(`[data-tab-id="${CSS.escape(activeTabId)}"]`)
    if (!strip || !tabEl) return
    if (scrolledTabIdRef.current === activeTabId && isTabFullyVisible(strip, tabEl)) return
    scrolledTabIdRef.current = activeTabId
    // scrollIntoView is not implemented in jsdom
    tabEl.scrollIntoView?.({ inline: 'nearest', block: 'nearest', behavior: scrollBehavior() })
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
    el.scrollBy({ left: distance * sign, behavior: scrollBehavior() })
  }

  const scrollToStart = (): void => scrollByLogical(-200)
  const scrollToEnd = (): void => scrollByLogical(200)

  return (
    // Same LazyMotion bundle the sidebar tree loads — `m.` components need the
    // feature set in context, and the two surfaces share the one chunk.
    <LazyMotion features={domAnimation}>
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
                <AnimatePresence initial={false}>
                  {pinnedTabs.map((tab) => (
                    <m.div
                      key={tab.id}
                      className="overflow-hidden"
                      initial={{ width: 0, opacity: 0 }}
                      animate={{ width: 36, opacity: 1, transition: tabEnterTransition }}
                      exit={{ width: 0, opacity: 0, transition: tabExitTransition }}
                    >
                      <TabContextMenu tab={tab} groupId={groupId}>
                        <PinnedTab
                          tab={tab}
                          groupId={groupId}
                          isActive={tab.id === group.activeTabId}
                        />
                      </TabContextMenu>
                    </m.div>
                  ))}
                </AnimatePresence>
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
              // Wheel scrolling assigns scrollLeft directly, which the CSS property
              // animates — so that one still needs the CSS-side gate.
              'scroll-smooth motion-reduce:scroll-auto',
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
              {/* The motion wrapper is the strip's flex item and the @container the
                tab's compression tiers query against (moved off SortableTab).
                Width animates through the min/max clamps so the flex share
                sweeps open on enter and shut on exit while neighbours reflow. */}
              <AnimatePresence initial={false}>
                {regularTabs.map((tab) => (
                  <m.div
                    key={tab.id}
                    className="no-drag @container flex-[1_1_var(--tab-w-max)] overflow-hidden"
                    initial={{ maxWidth: 0, minWidth: 0, opacity: 0 }}
                    animate={{
                      maxWidth: 240,
                      minWidth: 52,
                      opacity: 1,
                      transition: tabEnterTransition
                    }}
                    exit={{ maxWidth: 0, minWidth: 0, opacity: 0, transition: tabExitTransition }}
                  >
                    <SortableTab
                      tab={tab}
                      groupId={groupId}
                      isActive={tab.id === group.activeTabId}
                    />
                  </m.div>
                ))}
              </AnimatePresence>
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
    </LazyMotion>
  )
}

export default TabBarWithDrag
