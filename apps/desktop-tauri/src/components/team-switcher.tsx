'use client'

import * as React from 'react'
import { ChevronsUpDown, Plus, Check, Moon, Settings, LayoutGrid, LogOut } from '@/lib/icons'
import { useTheme } from 'next-themes'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@/components/ui/sidebar'
import { Switch } from '@/components/ui/switch'

export function TeamSwitcher({
  teams
}: {
  teams: {
    name: string
    logo: React.ElementType
  }[]
}) {
  const { isMobile } = useSidebar()
  const [activeTeam, setActiveTeam] = React.useState(teams[0])
  const { theme, setTheme } = useTheme()
  const isDarkMode = theme === 'dark'

  if (!activeTeam) {
    return null
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="bg-white rounded-md gap-2 border border-gray-200/60 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center"
            >
              <div className="flex aspect-square size-6 items-center justify-center rounded-full bg-sidebar-primary text-sidebar-primary-foreground">
                <activeTeam.logo className="size-3" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate font-normal">{activeTeam.name}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-64 rounded-xl p-2 shadow-lg border border-gray-200/80"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={8}
          >
            {/* Team list */}
            {teams.map((team) => {
              const isActive = activeTeam.name === team.name
              return (
                <DropdownMenuItem
                  key={team.name}
                  onClick={() => setActiveTeam(team)}
                  className="rounded-md cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors"
                >
                  <div className="flex size-7 items-center justify-center rounded-md border border-gray-200 bg-white">
                    <team.logo className="size-4 shrink-0" />
                  </div>
                  <span className="flex-1 font-medium text-gray-900">{team.name}</span>
                  {isActive && <Check className="size-4 text-gray-500" />}
                </DropdownMenuItem>
              )
            })}

            {/* Add workspace */}
            <DropdownMenuItem className="rounded-md cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors">
              <div className="flex size-7 items-center justify-center">
                <Plus className="size-4 text-gray-500" />
              </div>
              <span className="text-gray-600">New workspace</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator className="my-2 -mx-2 bg-gray-200/80" />

            {/* Settings section */}
            <DropdownMenuItem
              className="rounded-md cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors"
              onSelect={(e) => {
                e.preventDefault() // Prevent dropdown from closing
              }}
            >
              <div className="flex size-7 items-center justify-center">
                <Moon className="size-4 text-gray-500" />
              </div>
              <span className="flex-1 text-gray-900">Dark mode</span>
              <Switch
                checked={isDarkMode}
                onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
                onClick={(e) => e.stopPropagation()}
              />
            </DropdownMenuItem>

            <DropdownMenuItem className="rounded-md cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors">
              <div className="flex size-7 items-center justify-center">
                <Settings className="size-4 text-gray-500" />
              </div>
              <span className="text-gray-900">Settings</span>
            </DropdownMenuItem>

            <DropdownMenuItem className="rounded-md cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors">
              <div className="flex size-7 items-center justify-center">
                <LayoutGrid className="size-4 text-gray-500" />
              </div>
              <span className="text-gray-900">Integrations</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator className="my-2 -mx-2 bg-gray-200/80" />

            {/* Sign out */}
            <DropdownMenuItem className="rounded-md cursor-pointer hover:bg-red-50 focus:bg-red-50 transition-colors">
              <div className="flex size-7 items-center justify-center">
                <LogOut className="size-4 text-red-500" />
              </div>
              <span className="text-red-500 font-medium">Sign Out</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator className="my-2 -mx-2 bg-gray-200/80" />

            {/* Download on iOS */}
            <DropdownMenuItem className="rounded-md cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors">
              <div className="flex size-7 items-center justify-center">
                <svg className="size-4 text-gray-500" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
                </svg>
              </div>
              <span className="text-gray-600">Download on iOS</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
