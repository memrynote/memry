import type { ReactNode } from 'react'
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
}

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
  dock
}: AppRailProps): React.JSX.Element {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')

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
        data-tour="sidebar-nav"
        aria-label={tCommon('sidebar.railLabel')}
        // Spacing follows the macOS sidebar-rail convention (ChatGPT desktop as the
        // reference): 36px targets on a 44px pitch, first one 14px below the chrome row.
        className="flex flex-col items-center gap-2 pt-3.5"
      >
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
                    <button
                      type="button"
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
                    </button>
                  </ContextMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="right" className="flex items-center gap-2 py-1 ps-2.5 pe-1.5">
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
