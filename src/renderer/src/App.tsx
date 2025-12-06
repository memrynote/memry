import { useState, useMemo, useCallback } from "react"
import type { DragEndEvent } from "@dnd-kit/core"
import { arrayMove } from "@dnd-kit/sortable"
import { AppSidebar } from "@/components/app-sidebar"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { InboxPage } from "@/pages/inbox"
import { TasksPage } from "@/pages/tasks"
import { DragProvider, type DragState } from "@/contexts/drag-context"
import { TaskDragOverlay } from "@/components/tasks/drag-drop"
import { initialProjects, taskViews, type Project } from "@/data/tasks-data"
import { sampleTasks, type Task } from "@/data/sample-tasks"
import { getFilteredTasks } from "@/lib/task-utils"
import { toast } from "sonner"

// Base pages (non-task)
export type BasePage = "inbox" | "home"

// Task view type for navigation within tasks
export type TaskViewId = "all" | "today" | "upcoming" | "completed"

// Selection type for tasks page
export type TaskSelectionType = "view" | "project"

// Combined page type for routing
export type AppPage = BasePage | "tasks"

const pageTitles: Record<BasePage, string> = {
  inbox: "Inbox",
  home: "Home",
}

function App(): React.JSX.Element {
  // Navigation state
  const [currentPage, setCurrentPage] = useState<AppPage>("inbox")

  // Task-related state (lifted from TasksPage)
  const [taskSelectedId, setTaskSelectedId] = useState<string>("all")
  const [taskSelectedType, setTaskSelectedType] = useState<TaskSelectionType>("view")
  const [projects, setProjects] = useState<Project[]>(initialProjects)
  const [tasks, setTasks] = useState<Task[]>(sampleTasks)

  // Task selection state for drag-drop (lifted from TasksPage)
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())

  // Calculate view counts dynamically
  const viewCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    taskViews.forEach((view) => {
      const filtered = getFilteredTasks(tasks, view.id, "view", projects)
      counts[view.id] = filtered.length
    })
    return counts
  }, [tasks, projects])

  // Update project task counts
  const projectsWithCounts = useMemo(() => {
    return projects.map((project) => {
      const projectTasks = tasks.filter((t) => t.projectId === project.id)
      const incompleteTasks = projectTasks.filter((t) => {
        const status = project.statuses.find((s) => s.id === t.statusId)
        return status?.type !== "done"
      })
      return { ...project, taskCount: incompleteTasks.length }
    })
  }, [projects, tasks])

  // Navigation handlers
  const handleNavigate = useCallback((page: AppPage): void => {
    setCurrentPage(page)
  }, [])

  const handleSelectTaskView = useCallback((id: string): void => {
    setTaskSelectedId(id)
    setTaskSelectedType("view")
    setCurrentPage("tasks")
  }, [])

  const handleSelectProject = useCallback((id: string): void => {
    setTaskSelectedId(id)
    setTaskSelectedType("project")
    setCurrentPage("tasks")
  }, [])

  // Task handlers (passed to TasksPage)
  const handleTasksChange = useCallback((newTasks: Task[]): void => {
    setTasks(newTasks)
  }, [])

  const handleProjectsChange = useCallback((newProjects: Project[]): void => {
    setProjects(newProjects)
  }, [])

  // Drag-drop handler for App level (handles sidebar drops)
  const handleDragEnd = useCallback(
    (event: DragEndEvent, dragState: DragState) => {
      const { active, over } = event
      if (!over) return

      const overData = over.data.current
      const activeData = active.data.current

      // Handle dropping task on project in sidebar
      if (overData?.type === "project" && activeData?.type === "task") {
        const taskId = active.id as string
        const newProjectId = overData.projectId as string
        const task = tasks.find((t) => t.id === taskId)
        if (!task) return

        // Get the new project's default status
        const newProject = projects.find((p) => p.id === newProjectId)
        if (!newProject) return

        const defaultStatus = newProject.statuses.find((s) => s.type === "todo") || newProject.statuses[0]

        // Handle multi-select drag
        if (dragState.activeIds.length > 1) {
          setTasks((prev) =>
            prev.map((t) =>
              dragState.activeIds.includes(t.id)
                ? { ...t, projectId: newProjectId, statusId: defaultStatus?.id || t.statusId }
                : t
            )
          )
          toast.success(`Moved ${dragState.activeIds.length} tasks to ${newProject.name}`)
          setSelectedTaskIds(new Set())
        } else {
          setTasks((prev) =>
            prev.map((t) =>
              t.id === taskId
                ? { ...t, projectId: newProjectId, statusId: defaultStatus?.id || t.statusId }
                : t
            )
          )
          toast.success(`Moved task to ${newProject.name}`)
        }
        return
      }

      // Handle dropping task on a status column (for status change)
      if (overData?.type === "column" && activeData?.type === "task") {
        const taskId = active.id as string
        const newStatusId = overData.statusId as string || overData.columnId as string
        const task = tasks.find((t) => t.id === taskId)
        if (!task) return

        // Find the project for this task
        const project = projects.find((p) => p.id === task.projectId)
        if (!project) return

        // Find the target status
        const targetStatus = project.statuses.find((s) => s.id === newStatusId)
        if (!targetStatus) return

        // Don't update if already in the same status
        if (task.statusId === newStatusId) return

        // Handle multi-select drag
        if (dragState.activeIds.length > 1) {
          setTasks((prev) =>
            prev.map((t) =>
              dragState.activeIds.includes(t.id)
                ? {
                  ...t,
                  statusId: newStatusId,
                  // Mark as completed if moving to done status
                  completedAt: targetStatus.type === "done" ? new Date() : null
                }
                : t
            )
          )
          toast.success(`Moved ${dragState.activeIds.length} tasks to ${targetStatus.name}`)
          setSelectedTaskIds(new Set())
        } else {
          setTasks((prev) =>
            prev.map((t) =>
              t.id === taskId
                ? {
                  ...t,
                  statusId: newStatusId,
                  completedAt: targetStatus.type === "done" ? new Date() : null
                }
                : t
            )
          )
          toast.success(`Moved task to ${targetStatus.name}`)
        }
        return
      }

      // Handle project reordering in sidebar
      if (activeData?.type === undefined && over.id !== active.id) {
        // Check if this is a project reorder (active.id matches a project id)
        const activeIndex = projects.findIndex((p) => p.id === active.id)
        const overIndex = projects.findIndex((p) => p.id === over.id)
        if (activeIndex !== -1 && overIndex !== -1) {
          setProjects((prev) => arrayMove(prev, activeIndex, overIndex))
          return
        }
      }
    },
    [tasks, projects]
  )

  // Update selection from TasksPage
  const handleSelectionChange = useCallback((ids: Set<string>): void => {
    setSelectedTaskIds(ids)
  }, [])

  const handleTaskSelectionChange = useCallback((id: string, type: TaskSelectionType): void => {
    setTaskSelectedId(id)
    setTaskSelectedType(type)
  }, [])

  const renderPage = (): React.JSX.Element => {
    switch (currentPage) {
      case "tasks":
        return (
          <TasksPage
            selectedId={taskSelectedId}
            selectedType={taskSelectedType}
            tasks={tasks}
            projects={projectsWithCounts}
            onTasksChange={handleTasksChange}
            onSelectionChange={handleTaskSelectionChange}
            selectedTaskIds={selectedTaskIds}
            onSelectedTaskIdsChange={handleSelectionChange}
          />
        )
      case "inbox":
      default:
        return <InboxPage />
    }
  }

  // Tasks page has its own header, so we render it differently
  const isTasksPage = currentPage === "tasks"
  const pageTitle = isTasksPage ? "Tasks" : pageTitles[currentPage as BasePage]

  // Wrap content with DragProvider when on tasks page
  const tasksContent = (
    <>
      <AppSidebar
        currentPage={currentPage}
        taskSelectedId={taskSelectedId}
        taskSelectedType={taskSelectedType}
        onNavigate={handleNavigate}
        onSelectTaskView={handleSelectTaskView}
        onSelectProject={handleSelectProject}
        viewCounts={viewCounts}
        projects={projectsWithCounts}
        onProjectsChange={handleProjectsChange}
      />
      <SidebarInset>
        {!isTasksPage && (
          <header className="drag-region flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
            <div className="flex items-center gap-2 px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mr-2 data-[orientation=vertical]:h-4"
              />
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem className="hidden md:block">
                    <BreadcrumbLink href="#">
                      Building Your Application
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden md:block" />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{pageTitle}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </div>
          </header>
        )}
        <div className={isTasksPage ? "flex flex-1 flex-col" : "flex flex-1 flex-col gap-4 p-4 pt-0"}>
          {renderPage()}
        </div>
      </SidebarInset>
      {/* Drag Overlay - only for task drag to sidebar */}
      {isTasksPage && <TaskDragOverlay projects={projectsWithCounts} />}
    </>
  )

  return (
    <>
      <SidebarProvider>
        {isTasksPage ? (
          <DragProvider
            tasks={tasks}
            selectedIds={selectedTaskIds}
            onDragEnd={handleDragEnd}
          >
            {tasksContent}
          </DragProvider>
        ) : (
          tasksContent
        )}
      </SidebarProvider>
      <Toaster />
    </>
  )
}

export default App
