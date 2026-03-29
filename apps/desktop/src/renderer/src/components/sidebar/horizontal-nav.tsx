import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { AppPage } from '@/App'
import type { SidebarItem, TabType } from '@/contexts/tabs/types'

interface NavItem {
  title: string
  page: AppPage
  icon: React.ComponentType<{ className?: string; size?: number }>
  shortcut?: string
}

interface HorizontalNavProps {
  items: NavItem[]
  isActive: (item: SidebarItem) => boolean
  onNavClick: (page: AppPage) => (e: React.MouseEvent) => void
  inboxCount: number
  todayTasksCount: number
  isCollapsed?: boolean
}

export function HorizontalNav({
  items,
  isActive,
  onNavClick,
  inboxCount,
  todayTasksCount,
  isCollapsed = false
}: HorizontalNavProps) {
  return (
    <nav
      className={cn(
        'flex gap-0.5 px-2 py-1 transition-all duration-200',
        isCollapsed ? 'flex-col items-center px-1' : 'items-center'
      )}
    >
      {items.map((item) => {
        const sidebarItem: SidebarItem = {
          type: item.page as TabType,
          title: item.title,
          path: `/${item.page}`
        }
        const active = isActive(sidebarItem)
        const showLabel = active && !isCollapsed
        const badgeCount =
          item.page === 'inbox' ? inboxCount : item.page === 'tasks' ? todayTasksCount : 0

        const tooltipLabel = item.shortcut ? `${item.title} ${item.shortcut}` : item.title

        return (
          <Tooltip key={item.page}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onNavClick(item.page)}
                className={cn(
                  'relative flex h-7 cursor-pointer items-center rounded-md transition-all duration-200',
                  isCollapsed ? 'w-8 justify-center px-0' : 'px-2',
                  active
                    ? isCollapsed
                      ? 'bg-sidebar-accent'
                      : 'bg-sidebar-accent pl-2.5'
                    : 'hover:bg-sidebar-accent/60'
                )}
              >
                <item.icon
                  className={cn(
                    'size-[18px] shrink-0 transition-opacity duration-150',
                    active
                      ? 'text-sidebar-accent-foreground opacity-85'
                      : 'text-sidebar-foreground opacity-45'
                  )}
                />

                {/* Expanding label — grid trick for smooth width animation */}
                <div
                  className={cn(
                    'grid overflow-hidden transition-[grid-template-columns,opacity] duration-200',
                    showLabel ? 'grid-cols-[1fr] opacity-100' : 'grid-cols-[0fr] opacity-0'
                  )}
                >
                  <span className="overflow-hidden whitespace-nowrap">
                    <span
                      className={cn(
                        'ml-1.5 text-[13px] font-medium leading-4',
                        'text-sidebar-accent-foreground'
                      )}
                    >
                      {item.title}
                    </span>
                  </span>
                </div>

                {badgeCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-tint text-[8px] font-bold text-tint-foreground">
                    {badgeCount > 9 ? '9+' : badgeCount}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent
              side={isCollapsed ? 'right' : 'bottom'}
              align="center"
              hidden={showLabel}
              className="text-xs"
            >
              {tooltipLabel}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </nav>
  )
}
