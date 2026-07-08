import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge
} from '@/components/ui/sidebar'
import type { AppPage } from '@/App'
import type { SidebarItem, TabType } from '@/contexts/tabs/types'

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
  /** When the ⌘/Ctrl modifier is held, icons swap to their 1-based shortcut number. */
  isModifierHeld: boolean
  inboxCount: number
  todayTasksCount: number
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
  isModifierHeld,
  inboxCount,
  todayTasksCount
}: SidebarNavProps) {
  return (
    <SidebarGroup data-tour="sidebar-nav" className="shrink-0 py-1.5 pb-0">
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
              <SidebarMenuButton
                isActive={active}
                data-tour={`nav-${item.page}`}
                onClick={onNavClick(item.page)}
                className="h-7 rounded-[5px] p-0 ps-1 pe-2.5 gap-1.5 text-[13px] leading-4 font-medium text-sidebar-foreground"
              >
                {isModifierHeld && number <= 9 ? <NavNumber n={number} /> : <item.icon />}
                <span>{item.title}</span>
              </SidebarMenuButton>
              {badgeCount > 0 && (
                <SidebarMenuBadge>{badgeCount > 9 ? '9+' : badgeCount}</SidebarMenuBadge>
              )}
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}
