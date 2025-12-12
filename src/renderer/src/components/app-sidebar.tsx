"use client"

import * as React from "react"
import { useMemo } from "react"
import {
  AudioWaveform,
  BookOpen,
  Command,
  GalleryVerticalEnd,
  Home,
  Inbox,
  ListTodo,
  Plus,
  Search,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { TeamSwitcher } from "@/components/team-switcher"
import { TrafficLights } from "@/components/traffic-lights"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"
import { SidebarSection } from "@/components/sidebar-section"
import FileTree from "@/components/file-tree"
import { useSidebarNavigation } from "@/hooks/use-sidebar-navigation"
import type { SidebarItem, TabType } from "@/contexts/tabs/types"
import type { AppPage } from "@/App"

// Quick actions data with soft utility colors
const quickActions = [
  {
    title: "Search",
    icon: Search,
    kbd: "⌘ K",
    iconColor: "text-soft-slate",
  },
  {
    title: "New",
    icon: Plus,
    kbd: "⌘ N",
    iconColor: "text-soft-sage",
  },
]

// Main navigation data - now includes Tasks
const mainNav: {
  title: string
  page: AppPage
  icon: typeof Inbox
  iconColor: string
}[] = [
    {
      title: "Inbox",
      page: "inbox",
      icon: Inbox,
      iconColor: "text-accent-cyan",
    },
    {
      title: "Inbox 2",
      page: "inbox2",
      icon: Inbox,
      iconColor: "text-accent-cyan",
    },
    {
      title: "Home",
      page: "home",
      icon: Home,
      iconColor: "text-accent-green",
    },
    {
      title: "Journal",
      page: "journal",
      icon: BookOpen,
      iconColor: "text-accent-purple",
    },
    {
      title: "Tasks",
      page: "tasks",
      icon: ListTodo,
      iconColor: "text-accent-orange",
    },
  ]

// Team data
const data = {
  teams: [
    {
      name: "Kaan",
      logo: GalleryVerticalEnd,
      plan: "Enterprise",
    },
    {
      name: "Acme Corp.",
      logo: AudioWaveform,
      plan: "Startup",
    },
    {
      name: "Evil Corp.",
      logo: Command,
      plan: "Free",
    },
  ],
}

function SidebarHeaderContent({ teams }: { teams: typeof data.teams }) {
  const { state } = useSidebar()
  const isCollapsed = state === "collapsed"

  return (
    <SidebarHeader>
      {/* Drag region + Traffic lights for macOS */}
      <div
        className={cn(
          "drag-region flex items-center h-8 shrink-0 transition-all duration-200",
          isCollapsed ? "justify-center px-0" : "justify-start px-2"
        )}
      >
        <TrafficLights compact={isCollapsed} />
      </div>
      <TeamSwitcher teams={teams} />
    </SidebarHeader>
  )
}

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  currentPage: AppPage
  viewCounts: Record<string, number>
}

export function AppSidebar({
  currentPage,
  viewCounts,
  ...props
}: AppSidebarProps) {
  // Calculate today's tasks count for Tasks badge in sidebar
  const todayTasksCount = useMemo(() => {
    return viewCounts["today"] || 0
  }, [viewCounts])

  // Tab navigation hook
  const { openSidebarItem } = useSidebarNavigation()

  const handleNavClick = (page: AppPage) => (e: React.MouseEvent) => {
    e.preventDefault()

    // Map page to tab type and title
    const pageToTabType: Record<AppPage, TabType> = {
      inbox: "inbox",
      inbox2: "inbox2",
      home: "home",
      journal: "journal",
      tasks: "tasks", // New unified tasks tab type
    }
    const pageToTitle: Record<AppPage, string> = {
      inbox: "Inbox",
      inbox2: "Inbox 2",
      home: "Home",
      journal: "Journal",
      tasks: "Tasks",
    }

    // Open as tab in active pane
    const item: SidebarItem = {
      type: pageToTabType[page],
      title: pageToTitle[page],
      path: `/${page}`,
    }
    openSidebarItem(item)
  }

  return (
    <>
      <Sidebar collapsible="icon" {...props}>
        <SidebarHeaderContent teams={data.teams} />
        <SidebarContent>
          {/* Quick Actions: Search & New */}
          <SidebarGroup>
            <SidebarMenu>
              {quickActions.map((action) => (
                <SidebarMenuItem key={action.title}>
                  <SidebarMenuButton tooltip={action.title}>
                    <action.icon className={cn("size-4", action.iconColor)} />
                    <span>{action.title}</span>
                    <KbdGroup className="ml-auto">
                      <Kbd>{action.kbd}</Kbd>
                    </KbdGroup>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>

          <SidebarSeparator className="w-auto!" />

          {/* Main Navigation: Inbox, Home, Journal, Tasks */}
          <SidebarGroup>
            <SidebarMenu>
              {mainNav.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    tooltip={item.title}
                    isActive={currentPage === item.page}
                    onClick={handleNavClick(item.page)}
                  >
                    <item.icon className={cn("size-4", item.iconColor)} />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                  {/* Show today's task count badge for Tasks */}
                  {item.page === "tasks" && todayTasksCount > 0 && (
                    <SidebarMenuBadge>{todayTasksCount}</SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>

          <SidebarSeparator className="w-auto!" />

          {/* COLLECTIONS Section - Collapsible */}
          <SidebarSection id="collections" label="Collections" defaultExpanded={false}>
            <FileTree />
          </SidebarSection>
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
    </>
  )
}
