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
  shortcut?: string
}

interface SidebarNavProps {
  items: NavItem[]
  isActive: (item: SidebarItem) => boolean
  onNavClick: (page: AppPage) => (e: React.MouseEvent) => void
  inboxCount: number
  todayTasksCount: number
}

export function SidebarNav({
  items,
  isActive,
  onNavClick,
  inboxCount,
  todayTasksCount
}: SidebarNavProps) {
  return (
    <SidebarGroup className="shrink-0 py-1.5 pb-0">
      <SidebarMenu>
        {items.map((item) => {
          const sidebarItem: SidebarItem = {
            type: item.page as TabType,
            title: item.title,
            path: `/${item.page}`
          }
          const active = isActive(sidebarItem)
          const badgeCount =
            item.page === 'inbox' ? inboxCount : item.page === 'tasks' ? todayTasksCount : 0
          const tooltipLabel = item.shortcut ? `${item.title} ${item.shortcut}` : item.title

          return (
            <SidebarMenuItem key={item.page}>
              <SidebarMenuButton
                tooltip={tooltipLabel}
                isActive={active}
                onClick={onNavClick(item.page)}
                className="h-7 rounded-[5px] p-0 pl-1 pr-2.5 gap-1.5 text-[13px] leading-4 font-medium text-sidebar-foreground"
              >
                <item.icon />
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
