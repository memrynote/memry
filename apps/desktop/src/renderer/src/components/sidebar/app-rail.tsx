import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  useDndMonitor,
  type Active,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useT } from '@memry/i18n/renderer'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { OpenTargetMenuItems } from '@/components/sidebar/open-target-menu-items'
import { createTabFromSidebarItem } from '@/contexts/tabs/helpers'
import { Settings } from '@/lib/icons'
import { isMac } from '@/lib/shortcut-registry'
import { cn } from '@/lib/utils'
import { reorderSidebarSections } from '@/components/sidebar/sidebar-section-order'
import type { PageIconProps } from '@/lib/icons/page-icons'
import type { AppPage } from '@/App'
import type { SidebarItem, TabType } from '@/contexts/tabs/types'

/**
 * Width of the rail column. The sidebar provider holds this much room at the
 * inline start (`--sidebar-offset`) so the collapsible panel sits beside it.
 */
export const APP_RAIL_WIDTH_PX = 52

export interface AppRailItem {
  title: string
  page: AppPage
  /** Outline at rest, solid when `active`. See lib/icons/page-icons.tsx. */
  icon: React.ComponentType<PageIconProps>
}

interface AppRailProps {
  /** Already filtered to the visible sections, in display order. */
  items: AppRailItem[]
  isActive: (item: SidebarItem) => boolean
  onNavClick: (page: AppPage) => (e: React.MouseEvent) => void
  /** Middle-click opens a background tab; fires on mousedown, where button 1 is readable. */
  onNavMiddleClick: (page: AppPage) => (e: React.MouseEvent) => void
  /** When the ⌘/Ctrl modifier is held, icons swap to their 1-based shortcut number. */
  isModifierHeld: boolean
  inboxCount: number
  todayTasksCount: number
  onOpenJournalSettings: () => void
  /** Sync, feedback and settings: pinned to the rail's foot. */
  dock: ReactNode
  /** Called with the page ids in their new order after a drag-and-drop reorder. */
  onReorder?: (pages: string[]) => void
}

/**
 * Marks a draggable as a rail page icon, so the app-level collision detection
 * (drag-context.tsx) only offers other rail icons as drop targets.
 */
export const RAIL_ITEM_DRAG_TYPE = 'rail-item'

const isRailDrag = (active: Active | null): boolean =>
  active?.data.current?.type === RAIL_ITEM_DRAG_TYPE

/**
 * dnd-kit keys every draggable and droppable by id across the whole app-level
 * DndContext, and bare page ids collide there: the default Inbox project is
 * `useSortable({ id: 'inbox' })` in the sidebar's Projects list. With a shared
 * id, dragging the rail's Inbox picked up the project row instead, and every
 * other rail drag measured Inbox's slot at the project row's rect, so icons
 * jumped away and drops sprang back.
 */
const RAIL_SORTABLE_ID_PREFIX = 'app-rail:'
const toSortableId = (page: string): string => `${RAIL_SORTABLE_ID_PREFIX}${page}`
const toPage = (sortableId: string): string => sortableId.slice(RAIL_SORTABLE_ID_PREFIX.length)

function formatCount(count: number): string {
  return count > 9 ? '9+' : String(count)
}

/**
 * The always-visible icon column at the window's inline start. It holds the
 * top-level pages, which exist in every vault, so it stays put while the panel
 * beside it pages between vaults or collapses.
 */
export function AppRail({
  items,
  isActive,
  onNavClick,
  onNavMiddleClick,
  isModifierHeld,
  inboxCount,
  todayTasksCount,
  onOpenJournalSettings,
  dock,
  onReorder
}: AppRailProps): React.JSX.Element {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')

  const idKey = items.map((item) => toSortableId(item.page)).join('\u0000')
  const ids = useMemo(() => idKey.split('\u0000').filter(Boolean), [idKey])
  const navRef = useRef<HTMLElement>(null)
  // How far the carried icon may travel: from the first slot to the last, so it
  // cannot ride down into the dock. Measured at drag start, before anything moves.
  const travelRef = useRef<{ min: number; max: number } | null>(null)

  // The app mounts a DragOverlay for tasks, so dnd-kit never transforms the
  // drag source itself; the carried icon follows the pointer through this
  // offset instead (same approach as SortableSidebarSections).
  const [carried, setCarried] = useState<{ id: string; offsetY: number } | null>(null)
  const clearCarried = useCallback(() => {
    travelRef.current = null
    setCarried(null)
  }, [])

  const monitor = useMemo(
    () => ({
      onDragStart({ active }: DragStartEvent): void {
        if (!isRailDrag(active)) return
        const page = toPage(String(active.id))
        const buttons = Array.from(
          navRef.current?.querySelectorAll<HTMLElement>('[data-rail-page]') ?? []
        )
        const self = buttons.find((button) => button.dataset.railPage === page)
        const first = buttons.at(0)
        const last = buttons.at(-1)
        if (self && first && last) {
          const own = self.getBoundingClientRect()
          travelRef.current = {
            min: first.getBoundingClientRect().top - own.top,
            max: last.getBoundingClientRect().bottom - own.bottom
          }
        } else {
          travelRef.current = null
        }
        setCarried({ id: page, offsetY: 0 })
      },
      onDragMove({ active, delta }: DragMoveEvent): void {
        if (!isRailDrag(active)) return
        const travel = travelRef.current
        const offsetY = travel ? Math.min(travel.max, Math.max(travel.min, delta.y)) : delta.y
        setCarried({ id: toPage(String(active.id)), offsetY })
      },
      onDragEnd({ active, over }: DragEndEvent): void {
        if (!isRailDrag(active)) return
        clearCarried()
        if (!over || !onReorder) return
        const next = reorderSidebarSections(ids, String(active.id), String(over.id))
        if (next) onReorder(next.map(toPage))
      },
      onDragCancel: clearCarried
    }),
    [ids, onReorder, clearCarried]
  )
  useDndMonitor(monitor)

  return (
    <div
      data-testid="app-rail"
      // Above the sidebar container (z-10), which slides under the rail when it collapses.
      className="relative z-20 flex h-svh shrink-0 flex-col items-center bg-sidebar-rail pb-3"
      style={{ width: APP_RAIL_WIDTH_PX }}
    >
      {/* The window controls overlay covers this row (see App.tsx); the rest drags the window. */}
      <div className="drag-region h-9 w-full shrink-0" />
      {/* Start edge of the surface beside the rail (sidebar panel, or the workspace card when
          collapsed): rounded corner + border line. Drawn by the rail so it stays put while the
          sidebar slides under the rail; at rest it overlaps the surface's own identical edge.
          The corner's shadow paints rail colour outside the arc. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute start-full top-9 size-4 rounded-ss-xl border-s border-t border-border shadow-[-8px_-8px_0_8px_var(--sidebar-rail)] rtl:shadow-[8px_-8px_0_8px_var(--sidebar-rail)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute start-full top-13 bottom-0 w-px bg-border"
      />
      <nav
        ref={navRef}
        data-tour="sidebar-nav"
        aria-label={tCommon('sidebar.railLabel')}
        // Spacing follows the macOS sidebar-rail convention (ChatGPT desktop as the
        // reference): 36px targets on a 44px pitch, first one 14px below the chrome row.
        className="flex flex-col items-center gap-2 pt-3.5"
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {items.map((item, index) => {
            const sidebarItem: SidebarItem = {
              type: item.page as TabType,
              title: item.title,
              path: `/${item.page}`
            }
            const active = isActive(sidebarItem)
            const badgeCount =
              item.page === 'inbox' ? inboxCount : item.page === 'tasks' ? todayTasksCount : 0
            const number = index + 1
            const hasShortcut = number <= 9

            return (
              <ContextMenu key={item.page}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <ContextMenuTrigger asChild>
                      <SortableRailButton
                        page={item.page}
                        carriedOffset={carried?.id === item.page ? carried.offsetY : null}
                        data-rail-page={item.page}
                        data-tour={`nav-${item.page}`}
                        data-testid={`rail-${item.page}`}
                        data-active={active || undefined}
                        aria-label={item.title}
                        aria-current={active ? 'page' : undefined}
                        onClick={onNavClick(item.page)}
                        onMouseDown={onNavMiddleClick(item.page)}
                        className={cn(
                          'relative flex size-9 items-center justify-center rounded-[8px] text-sidebar-rail-foreground transition-colors duration-100',
                          'hover:bg-sidebar-accent hover:text-sidebar-primary',
                          // Ink, not tint: a focus ring must clear 3:1 whatever accent the user picked.
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary',
                          'data-[active]:bg-sidebar-rail-active data-[active]:text-sidebar-rail-active-foreground data-[active]:shadow-[0_0_0_1px_var(--sidebar-border),0_1px_2px_rgb(0_0_0/0.05)]',
                          '[&_svg]:size-5'
                        )}
                      >
                        {isModifierHeld && hasShortcut ? (
                          <span className="text-[11px] font-semibold leading-none tabular-nums">
                            {number}
                          </span>
                        ) : (
                          // 1.8 lands on 1.5 device px at this size. See page-icons.tsx.
                          <item.icon active={active} strokeWidth={1.8} />
                        )}
                        {badgeCount > 0 && (
                          <span
                            data-testid={`rail-badge-${item.page}`}
                            className="absolute -end-[3px] top-0 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-sidebar-primary px-1 text-[9px] font-semibold leading-none text-sidebar-primary-foreground tabular-nums ring-2 ring-sidebar-rail"
                          >
                            {formatCount(badgeCount)}
                          </span>
                        )}
                      </SortableRailButton>
                    </ContextMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent
                    side="right"
                    className="flex items-center gap-2 py-1 ps-2.5 pe-1.5"
                  >
                    <span>{item.title}</span>
                    {hasShortcut && (
                      <Kbd className="h-4 min-w-4 text-[10px]">
                        {isMac ? `⌘${number}` : `Ctrl ${number}`}
                      </Kbd>
                    )}
                  </TooltipContent>
                </Tooltip>
                <ContextMenuContent>
                  {/* Home, Inbox, Calendar, … are singletons, so OpenTargetMenuItems drops
                    "Open in New Tab" for them and the menu is just "Open to the Side". */}
                  <OpenTargetMenuItems tab={createTabFromSidebarItem(sidebarItem)} />
                  {/* Journal is the only section with a per-section settings page worth
                    reaching from the icon itself. */}
                  {item.page === 'journal' && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem onClick={onOpenJournalSettings}>
                        <Settings className="me-2 h-4 w-4" />
                        {t('tree.actions.journalSettings')}
                      </ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </SortableContext>
      </nav>
      <div className="flex-1" />
      <div
        data-testid="app-rail-dock"
        className="flex flex-col items-center gap-2 [&_[data-slot=dock-button]]:size-9"
      >
        {dock}
      </div>
    </div>
  )
}

interface SortableRailButtonProps extends React.ComponentPropsWithoutRef<'button'> {
  page: string
  /** How far the pointer has carried this icon, or null when it is at rest. */
  carriedOffset: number | null
}

/**
 * A rail page button that can be dragged to a new slot. Only the pointer
 * listener is wired: dnd-kit's keyboard listener claims Enter/Space, which must
 * keep opening the page. Radix triggers (tooltip, context menu) wrap this via
 * `asChild`, so their props and ref arrive here and are merged.
 */
function SortableRailButton({
  page,
  carriedOffset,
  style,
  onPointerDown,
  ref: forwardedRef,
  ...props
}: SortableRailButtonProps & { ref?: React.Ref<HTMLButtonElement> }): React.JSX.Element {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: toSortableId(page),
    data: { type: RAIL_ITEM_DRAG_TYPE }
  })

  const setRefs = useCallback(
    (node: HTMLButtonElement | null) => {
      setNodeRef(node)
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    },
    [setNodeRef, forwardedRef]
  )

  const dragTransform =
    carriedOffset !== null
      ? `translate3d(0, ${carriedOffset}px, 0)`
      : CSS.Translate.toString(transform)

  return (
    <button
      type="button"
      {...props}
      ref={setRefs}
      data-dragging={isDragging || undefined}
      style={{
        ...style,
        transform: dragTransform,
        // No transition on the carried icon: it has to sit under the pointer.
        transition: carriedOffset !== null ? undefined : transition,
        zIndex: isDragging ? 30 : undefined
      }}
      onPointerDown={(e) => {
        onPointerDown?.(e)
        listeners?.onPointerDown?.(e)
      }}
    />
  )
}
