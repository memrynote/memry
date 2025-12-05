import { useState, useMemo, useCallback } from "react"
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
import { initialProjects, taskViews, type Project } from "@/data/tasks-data"
import { sampleTasks, type Task } from "@/data/sample-tasks"
import { getFilteredTasks } from "@/lib/task-utils"

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

  return (
    <>
      <SidebarProvider>
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
      </SidebarProvider>
      <Toaster />
    </>
  )
}

export default App
