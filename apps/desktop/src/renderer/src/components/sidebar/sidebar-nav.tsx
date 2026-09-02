import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge
} from '@/components/ui/sidebar'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { ChevronRight, Settings } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { OpenTargetMenuItems } from '@/components/sidebar/open-target-menu-items'
import { useSidebarNavCollapsed } from '@/hooks/use-sidebar-nav-collapsed'
import { createTabFromSidebarItem } from '@/contexts/tabs/helpers'
import type { AppPage } from '@/App'
import type { SidebarItem, TabType } from '@/contexts/tabs/types'

const NAV_CONTENT_ID = 'sidebar-nav-items'

interface NavItem {
  title: string
  page: AppPage
  icon: React.ComponentType<{ className?: string; size?: number }>
}

interface SidebarNavProps {
  /** Already filtered to the visible sections, in display order. */
  items: NavItem[]
  isActive: (item: SidebarItem) => boolean
  onNavClick: (page: AppPage) => (e: React.MouseEvent) => void
  /** Middle-click opens a background tab; fires on mousedown, where button 1 is readable. */
  onNavMiddleClick: (page: AppPage) => (e: React.MouseEvent) => void
  /** When the ⌘/Ctrl modifier is held, icons swap to their 1-based shortcut number. */
  isModifierHeld: boolean
  inboxCount: number
  todayTasksCount: number
  /**
   * Opens Settings on the Journal section. Passed in rather than read from the
   * settings-modal context here so this component stays free of providers.
   */
  onOpenJournalSettings: () => void
}

/** The ordinal shortcut number, sized to match the section icon so the row doesn't shift. */
function NavNumber({ n }: { n: number }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center text-[11px] font-semibold leading-none">
      {n}
    </span>
  )
}

export function SidebarNav({
  items,
  isActive,
  onNavClick,
  onNavMiddleClick,
  isModifierHeld,
  inboxCount,
  todayTasksCount,
  onOpenJournalSettings
}: SidebarNavProps) {
  const { t } = useT('notes')
  const { collapsed, setCollapsed } = useSidebarNavCollapsed()

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowRight':
        if (collapsed) {
          e.preventDefault()
          setCollapsed(false)
        }
        break
      case 'ArrowLeft':
        if (!collapsed) {
          e.preventDefault()
          setCollapsed(true)
        }
        break
    }
  }

  return (
    <SidebarGroup data-tour="sidebar-nav" className="group/nav shrink-0 py-1.5 pb-0">
      {/* Not SidebarSection: that one keeps its expanded flag in localStorage,
          and this block's flag is a synced setting. */}
      <div className="flex items-center h-6 [font-synthesis:none]">
        <button
          type="button"
          data-testid="sidebar-nav-toggle"
          onClick={() => setCollapsed(!collapsed)}
          onKeyDown={handleKeyDown}
          className={cn(
            'flex flex-1 min-w-0 cursor-pointer items-center gap-1.5 px-2 py-1 h-6 shrink-0',
            'text-[11px] leading-3.5 font-medium tracking-[0.04em]',
            "font-['DM_Sans',system-ui,sans-serif]",
            'text-sidebar-section-heading',
            'focus-visible:outline-none'
          )}
          aria-expanded={!collapsed}
          aria-controls={NAV_CONTENT_ID}
          aria-label={collapsed ? t('tree.nav.ariaCollapsed') : t('tree.nav.ariaExpanded')}
        >
          <span className="truncate text-start uppercase">{t('tree.nav.label')}</span>
          <ChevronRight
            size={10}
            className={cn(
              // Decorative to assistive tech, but it is the header's only visible
              // focus state: the header sets `focus-visible:outline-none` and the
              // app paints no global focus ring, so a chevron that stayed at
              // `opacity-0` would leave a keyboard user with nothing on screen at all.
              'shrink-0 text-sidebar-muted transition-transform duration-200 ease-in-out motion-reduce:transition-none opacity-0 group-hover/nav:opacity-100 group-focus-within/nav:opacity-100',
              !collapsed && 'rotate-90'
            )}
            aria-hidden="true"
          />
        </button>
      </div>
      <section
        id={NAV_CONTENT_ID}
        data-testid="sidebar-nav-items"
        aria-hidden={collapsed}
        // `aria-hidden` alone would leave eight buttons in the tab order behind
        // a zero-height row — a keyboard user would tab into rows that are not
        // on screen and that screen readers have been told do not exist.
        inert={collapsed}
        className={cn(
          'grid transition-[grid-template-rows] duration-100 ease-out motion-reduce:transition-none',
          collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
        )}
      >
        <div className="overflow-hidden">
          <SidebarMenu>
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

              return (
                <SidebarMenuItem key={item.page}>
                  {/* Home, Inbox, Calendar, … are singletons, so OpenTargetMenuItems
                      drops "Open in New Tab" for them on its own and the menu is just
                      "Open to the Side". */}
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <SidebarMenuButton
                        isActive={active}
                        data-tour={`nav-${item.page}`}
                        onClick={onNavClick(item.page)}
                        onMouseDown={onNavMiddleClick(item.page)}
                        className="h-7 rounded-[5px] p-0 ps-1 pe-2.5 gap-1.5 text-[13px] leading-4 font-medium text-sidebar-foreground"
                      >
                        {isModifierHeld && number <= 9 ? <NavNumber n={number} /> : <item.icon />}
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <OpenTargetMenuItems tab={createTabFromSidebarItem(sidebarItem)} />
                      {/* Journal is the only section with a per-section settings
                          page worth reaching from the row itself. The label is not
                          narrowed to "template settings": the section also holds
                          the journal folder, filename format and sidebar
                          visibility. */}
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
                  {badgeCount > 0 && (
                    <SidebarMenuBadge>{badgeCount > 9 ? '9+' : badgeCount}</SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
        </div>
      </section>
    </SidebarGroup>
  )
}
