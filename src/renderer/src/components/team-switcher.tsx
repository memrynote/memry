'use client'

import * as React from 'react'
import { ChevronsUpDown, Plus, Check } from 'lucide-react'
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
              className="bg-white rounded-lg gap-2 border border-gray-200/60 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center"
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
                  className="rounded-lg cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors"
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
            <DropdownMenuItem className="rounded-lg cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors">
              <div className="flex size-7 items-center justify-center">
                <Plus className="size-4 text-gray-500" />
              </div>
              <span className="text-gray-600">New workspace</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator className="my-2 -mx-2 bg-gray-200/80" />

            {/* Settings section */}
            <DropdownMenuItem
              className="rounded-lg cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors"
              onSelect={(e) => {
                e.preventDefault() // Prevent dropdown from closing
              }}
            >
              <div className="flex size-7 items-center justify-center">
                <svg
                  className="size-4 text-gray-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"
                  />
                </svg>
              </div>
              <span className="flex-1 text-gray-900">Dark mode</span>
              <Switch
                checked={isDarkMode}
                onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
                onClick={(e) => e.stopPropagation()}
              />
            </DropdownMenuItem>

            <DropdownMenuItem className="rounded-lg cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors">
              <div className="flex size-7 items-center justify-center">
                <svg
                  className="size-4 text-gray-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                  />
                </svg>
              </div>
              <span className="text-gray-900">Settings</span>
            </DropdownMenuItem>

            <DropdownMenuItem className="rounded-lg cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors">
              <div className="flex size-7 items-center justify-center">
                <svg
                  className="size-4 text-gray-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 0 0 2.25-2.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v2.25A2.25 2.25 0 0 0 6 10.5Zm0 9.75h2.25A2.25 2.25 0 0 0 10.5 18v-2.25a2.25 2.25 0 0 0-2.25-2.25H6a2.25 2.25 0 0 0-2.25 2.25V18A2.25 2.25 0 0 0 6 20.25Zm9.75-9.75H18a2.25 2.25 0 0 0 2.25-2.25V6A2.25 2.25 0 0 0 18 3.75h-2.25A2.25 2.25 0 0 0 13.5 6v2.25a2.25 2.25 0 0 0 2.25 2.25Z"
                  />
                </svg>
              </div>
              <span className="text-gray-900">Integrations</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator className="my-2 -mx-2 bg-gray-200/80" />

            {/* Sign out */}
            <DropdownMenuItem className="rounded-lg cursor-pointer hover:bg-red-50 focus:bg-red-50 transition-colors">
              <div className="flex size-7 items-center justify-center">
                <svg
                  className="size-4 text-red-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8.25 9V5.25A2.25 2.25 0 0 1 10.5 3h6a2.25 2.25 0 0 1 2.25 2.25v13.5A2.25 2.25 0 0 1 16.5 21h-6a2.25 2.25 0 0 1-2.25-2.25V15m-3 0-3-3m0 0 3-3m-3 3H15"
                  />
                </svg>
              </div>
              <span className="text-red-500 font-medium">Sign Out</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator className="my-2 -mx-2 bg-gray-200/80" />

            {/* Download on iOS */}
            <DropdownMenuItem className="rounded-lg cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors">
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
