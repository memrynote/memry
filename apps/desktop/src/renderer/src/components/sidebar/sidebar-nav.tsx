import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import type { AppPage } from '@/App'
import type { SidebarItem, TabType } from '@/contexts/tabs/types'

interface NavItem {
  title: string
  page: AppPage
  icon: React.ComponentType<{ className?: string; size?: number }>
}

interface SidebarNavProps {
  items: NavItem[]
  isActive: (item: SidebarItem) => boolean
  onNavClick: (page: AppPage) => (e: React.MouseEvent) => void
  isDisabled: (page: AppPage) => boolean
  inboxCount: number
  todayTasksCount: number
}

export function SidebarNav({
  items,
  isActive,
  onNavClick,
  isDisabled,
  inboxCount,
  todayTasksCount
}: SidebarNavProps) {
  return (
    <SidebarGroup data-tour="sidebar-nav" className="shrink-0 py-1.5 pb-0">
      <SidebarMenu>
        {items.map((item) => {
          const sidebarItem: SidebarItem = {
            type: item.page as TabType,
            title: item.title,
            path: `/${item.page}`
          }
          const active = isActive(sidebarItem)
          const disabled = isDisabled(item.page)
          const badgeCount = disabled
            ? 0
            : item.page === 'inbox'
              ? inboxCount
              : item.page === 'tasks'
                ? todayTasksCount
                : 0

          return (
            <SidebarMenuItem key={item.page}>
              <SidebarMenuButton
                isActive={!disabled && active}
                aria-disabled={disabled}
                data-tour={`nav-${item.page}`}
                onClick={onNavClick(item.page)}
                className={cn(
                  'h-7 rounded-[5px] p-0 ps-1 pe-2.5 gap-1.5 text-[13px] leading-4 font-medium text-sidebar-foreground',
                  disabled && 'opacity-50 text-muted-foreground'
                )}
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
