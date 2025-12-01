"use client"

import * as React from "react"
import {
  AudioWaveform,
  Command,
  Frame,
  GalleryVerticalEnd,
  Home,
  Inbox,
  ListTodo,
  Map,
  PieChart,
  Plus,
  Search,
} from "lucide-react"

import { NavProjects } from "@/components/nav-projects"
import { InputGroup } from "@/components/ui/input-group"
import { NavUser } from "@/components/nav-user"
import { TeamSwitcher } from "@/components/team-switcher"
import { Kbd } from "@/components/ui/kbd"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar"

// Quick actions data
const quickActions = [
  {
    title: "New",
    icon: Plus,
    kbd: "⌘N",
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
  user: {
    name: "shadcn",
    email: "m@example.com",
    avatar: "/avatars/shadcn.jpg",
  },
  teams: [
    {
      name: "Acme Inc",
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
  projects: [
    {
      name: "Design Engineering",
      url: "#",
      icon: Frame,
    },
    {
      name: "Sales & Marketing",
      url: "#",
      icon: PieChart,
    },
    {
      name: "Travel",
      url: "#",
      icon: Map,
    },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher teams={data.teams} />
      </SidebarHeader>
      <SidebarContent>
        {/* Quick Actions: Search & New */}
        <SidebarGroup>
          <SidebarMenu>
            {/* Search Input */}
            <SidebarMenuItem>
              <InputGroup className="h-8 w-full border-none shadow-none bg-transparent hover:bg-sidebar-accent rounded-md p-2 gap-2 overflow-hidden">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search..."
                  className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground min-w-0"
                />
                <Kbd>⌘K</Kbd>
              </InputGroup>
            </SidebarMenuItem>

            {/* New Button */}
            {quickActions.map((action) => (
              <SidebarMenuItem key={action.title}>
                <SidebarMenuButton tooltip={action.title}>
                  <action.icon />
                  <span>{action.title}</span>
                  <Kbd className="ml-auto">{action.kbd}</Kbd>
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

        <NavProjects projects={data.projects} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
