"use client"

import * as React from "react"
import {
  AudioWaveform,
  Calendar,
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"
import TreeComponent from "@/components/comp-567"

// Quick actions data
const quickActions = [
  {
    title: "Search",
    icon: Search,
    kbd: "⌘ K",
  },
  {
    title: "New",
    icon: Plus,
    kbd: "⌘ N",
  },
]

// Main navigation data
const mainNav = [
  {
    title: "Home",
    url: "#",
    icon: Home,
  },
  {
    title: "Today",
    url: "#",
    icon: Calendar,
  },
  {
    title: "Inbox",
    url: "#",
    icon: Inbox,
  },
  {
    title: "Tasks",
    url: "#",
    icon: ListTodo,
  },
]

// This is sample data.
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

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeaderContent teams={data.teams} />
      <SidebarContent>
        {/* Quick Actions: Search & New */}
        <SidebarGroup>
          <SidebarMenu>
            {quickActions.map((action) => (
              <SidebarMenuItem key={action.title}>
                <SidebarMenuButton tooltip={action.title}>
                  <action.icon />
                  <span>{action.title}</span>
                  <KbdGroup className="ml-auto">
                    <Kbd>{action.kbd}</Kbd>
                  </KbdGroup>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarSeparator className="!w-auto" />

        {/* Main Navigation: Home, Inbox, Tasks */}
        <SidebarGroup>
          <SidebarMenu>
            {mainNav.map((item) => (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton tooltip={item.title} asChild>
                  <a href={item.url}>
                    <item.icon />
                    <span>{item.title}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>

        {/* File Tree */}
        <SidebarGroup className="flex-1 overflow-auto">
          <TreeComponent />
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
