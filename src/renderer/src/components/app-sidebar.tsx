"use client"

import * as React from "react"
import { useState, useMemo } from "react"
import {
  AudioWaveform,
  BookOpen,
  CalendarDays,
  Check,
  Command,
  GalleryVerticalEnd,
  Home,
  Inbox,
  List,
  Plus,
  Search,
  Star,
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
import { SortableProjectList } from "@/components/sidebar/sortable-project-list"
import FileTree from "@/components/file-tree"
import { ProjectModal } from "@/components/tasks/project-modal"
import { DeleteProjectDialog, type DeleteTasksOption } from "@/components/tasks/delete-project-dialog"
import { useSidebarNavigation } from "@/hooks/use-sidebar-navigation"
import type { SidebarItem, TabType } from "@/contexts/tabs/types"
import type { AppPage, TaskSelectionType } from "@/App"
import type { Project } from "@/data/tasks-data"

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

// Main navigation data (simplified - no Tasks/Today since they're in the TASKS section)
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
  ]

// Task views configuration
const taskViewsConfig = [
  { id: "all", label: "All Tasks", icon: List, iconColor: "text-soft-slate" },
  { id: "today", label: "Today", icon: Star, iconColor: "text-accent-orange" },
  { id: "upcoming", label: "Upcoming", icon: CalendarDays, iconColor: "text-accent-blue" },
  { id: "completed", label: "Completed", icon: Check, iconColor: "text-accent-green" },
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
  taskSelectedId: string
  taskSelectedType: TaskSelectionType
  onNavigate: (page: AppPage) => void
  onSelectTaskView: (id: string) => void
  onSelectProject: (id: string) => void
  viewCounts: Record<string, number>
  projects: Project[]
  onProjectsChange: (projects: Project[]) => void
}

export function AppSidebar({
  currentPage,
  taskSelectedId,
  taskSelectedType,
  onNavigate,
  onSelectTaskView,
  onSelectProject,
  viewCounts,
  projects,
  onProjectsChange,
  ...props
}: AppSidebarProps) {
  // Project modal state
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null)

  // Calculate total tasks count for TASKS section (shown when collapsed)
  const totalTasksCount = useMemo(() => {
    return viewCounts["all"] || 0
  }, [viewCounts])

  // Tab navigation hook
  const { openSidebarItem } = useSidebarNavigation()

  // Map task view IDs to TabTypes
  const viewIdToTabType: Record<string, TabType> = {
    "all": "all-tasks",
    "today": "today",
    "upcoming": "upcoming",
    "completed": "completed",
  }

  const handleNavClick = (page: AppPage) => (e: React.MouseEvent) => {
    e.preventDefault()
    // Tab system handles navigation - no need to change currentPage
    // onNavigate(page) - REMOVED: was causing split view to reset

    // Map page to tab type and title
    const pageToTabType: Record<AppPage, TabType> = {
      inbox: "inbox",
      home: "home",
      journal: "journal",
      tasks: "all-tasks",
    }
    const pageToTitle: Record<AppPage, string> = {
      inbox: "Inbox",
      home: "Home",
      journal: "Journal",
      tasks: "All Tasks",
    }

    // Open as tab in active pane
    const item: SidebarItem = {
      type: pageToTabType[page],
      title: pageToTitle[page],
      path: `/${page}`,
    }
    openSidebarItem(item)
  }

  const handleTaskViewClick = (viewId: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    onSelectTaskView(viewId)

    // Also open as tab
    const viewConfig = taskViewsConfig.find(v => v.id === viewId)
    const item: SidebarItem = {
      type: viewIdToTabType[viewId] || "all-tasks",
      title: viewConfig?.label || "All Tasks",
      path: `/tasks/${viewId}`,
    }
    openSidebarItem(item)
  }

  const handleNewProject = (): void => {
    setEditingProject(null)
    setIsProjectModalOpen(true)
  }

  const handleEditProject = (project: Project): void => {
    setEditingProject(project)
    setIsProjectModalOpen(true)
  }

  const handleProjectModalClose = (): void => {
    setIsProjectModalOpen(false)
    setEditingProject(null)
  }

  const handleProjectSave = (project: Project): void => {
    const existingIndex = projects.findIndex((p) => p.id === project.id)
    if (existingIndex >= 0) {
      const updated = [...projects]
      updated[existingIndex] = project
      onProjectsChange(updated)
    } else {
      onProjectsChange([...projects, project])
    }
  }

  const handleProjectDelete = (projectId: string): void => {
    const project = projects.find((p) => p.id === projectId)
    if (project && !project.isDefault) {
      setProjectToDelete(project)
      setIsDeleteDialogOpen(true)
      setIsProjectModalOpen(false)
    }
  }

  const handleDeleteDialogClose = (): void => {
    setIsDeleteDialogOpen(false)
    setProjectToDelete(null)
  }

  const handleDeleteConfirm = (option: DeleteTasksOption): void => {
    if (!projectToDelete) return

    // Note: Task handling would need to be done at App level
    // For now, just remove the project
    onProjectsChange(projects.filter((p) => p.id !== projectToDelete.id))

    // If deleted project was selected, switch to "All Tasks"
    if (taskSelectedId === projectToDelete.id) {
      onSelectTaskView("all")
    }

    setIsDeleteDialogOpen(false)
    setProjectToDelete(null)
  }

  const handleArchiveProject = (project: Project): void => {
    const updated = projects.map((p) =>
      p.id === project.id ? { ...p, isArchived: true } : p
    )
    onProjectsChange(updated)

    // If archived project was selected, switch to "All Tasks"
    if (taskSelectedId === project.id) {
      onSelectTaskView("all")
    }
  }

  // Filter out archived projects for display
  const visibleProjects = projects.filter((p) => !p.isArchived)

  // Check if a task view is active
  const isTaskViewActive = (viewId: string): boolean => {
    return currentPage === "tasks" && taskSelectedType === "view" && taskSelectedId === viewId
  }

  // Check if a project is active
  const isProjectActive = (projectId: string): boolean => {
    return currentPage === "tasks" && taskSelectedType === "project" && taskSelectedId === projectId
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

          {/* Main Navigation: Inbox, Home */}
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
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>

          <SidebarSeparator className="w-auto!" />

          {/* TASKS Section - Collapsible */}
          <SidebarSection id="tasks" label="Tasks" defaultExpanded={true} totalCount={totalTasksCount}>
            {/* Task Views */}
            {taskViewsConfig.map((view) => (
              <SidebarMenuItem key={view.id}>
                <SidebarMenuButton
                  tooltip={view.label}
                  isActive={isTaskViewActive(view.id)}
                  onClick={handleTaskViewClick(view.id)}
                >
                  <view.icon className={cn("size-4", view.iconColor)} />
                  <span>{view.label}</span>
                </SidebarMenuButton>
                {viewCounts[view.id] !== undefined && viewCounts[view.id] > 0 && (
                  <SidebarMenuBadge>{viewCounts[view.id]}</SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            ))}

            {/* Dashed divider between views and projects */}
            <div className="my-2 mx-2 border-t border-dashed border-sidebar-border" />

            {/* Scrollable Projects Container */}
            <div className="max-h-[300px] overflow-y-auto scrollbar-thin">
              {/* Projects - Sortable List */}
              <SortableProjectList
                projects={visibleProjects}
                activeProjectId={isProjectActive(taskSelectedId) ? taskSelectedId : null}
                onProjectClick={(projectId) => {
                  onSelectProject(projectId)
                  // Also open as tab
                  const project = projects.find(p => p.id === projectId)
                  if (project) {
                    const item: SidebarItem = {
                      type: "project",
                      title: project.name,
                      path: `/project/${projectId}`,
                      entityId: projectId,
                    }
                    openSidebarItem(item)
                  }
                }}
                onProjectEdit={handleEditProject}
                onProjectArchive={handleArchiveProject}
                onProjectDelete={handleProjectDelete}
                onProjectsReorder={onProjectsChange}
                onCreateProject={handleNewProject}
              />

              {/* New Project Button - always visible at bottom */}
              {visibleProjects.length > 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip="New Project"
                    onClick={handleNewProject}
                    className="text-sidebar-foreground/70"
                  >
                    <Plus className="size-4" />
                    <span>New Project</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </div>
          </SidebarSection>

          <SidebarSeparator className="w-auto!" />

          {/* COLLECTIONS Section - Collapsible */}
          <SidebarSection id="collections" label="Collections" defaultExpanded={false}>
            <FileTree />
          </SidebarSection>
        </SidebarContent>
        <SidebarRail />
      </Sidebar>

      {/* Project Modal */}
      <ProjectModal
        isOpen={isProjectModalOpen}
        onClose={handleProjectModalClose}
        onSave={handleProjectSave}
        onDelete={handleProjectDelete}
        project={editingProject}
      />

      {/* Delete Project Dialog */}
      <DeleteProjectDialog
        isOpen={isDeleteDialogOpen}
        onClose={handleDeleteDialogClose}
        onConfirm={handleDeleteConfirm}
        project={projectToDelete}
      />
    </>
  )
}
