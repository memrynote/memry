import { useState, useMemo, useCallback } from "react"
import type { DragEndEvent } from "@dnd-kit/core"
import { arrayMove } from "@dnd-kit/sortable"
import { AppSidebar } from "@/components/app-sidebar"
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

// Tab System imports
import { TabProvider, useTabs, useActiveTab, getOrderedGroupWidths } from "@/contexts/tabs"
import { TasksProvider } from "@/contexts/tasks"
import { TabBarWithDrag, RecentlyClosedMenu, TabDragProvider } from "@/components/tabs"
import { SplitViewContainer } from "@/components/split-view"
import { ChordIndicator, KeyboardShortcutsDialog } from "@/components/keyboard"
import { useTabKeyboardShortcuts, useChordShortcuts } from "@/hooks"

// Base pages (non-task)
export type BasePage = "inbox" | "home"

// Task view type for navigation within tasks
export type TaskViewId = "all" | "today" | "upcoming" | "completed"

// Selection type for tasks page
export type TaskSelectionType = "view" | "project"

// Combined page type for routing
export type AppPage = BasePage | "tasks"

// =============================================================================
// TAB CONTENT RENDERER
// =============================================================================

interface TabContentRendererProps {
  tasks: Task[]
  projects: Project[]
  selectedTaskIds: Set<string>
  onTasksChange: (tasks: Task[]) => void
  onSelectionChange: (id: string, type: TaskSelectionType) => void
  onSelectedTaskIdsChange: (ids: Set<string>) => void
}

const TabContentRenderer = ({
  tasks,
  projects,
  selectedTaskIds,
  onTasksChange,
  onSelectionChange,
  onSelectedTaskIdsChange,
}: TabContentRendererProps): React.JSX.Element => {
  const activeTab = useActiveTab()

  if (!activeTab) {
    return <InboxPage />
  }

  // Route based on tab type
  switch (activeTab.type) {
    case "inbox":
      return <InboxPage />
    case "all-tasks":
    case "today":
    case "upcoming":
    case "completed":
    case "project": {
      // Derive selection from active tab (not from external state)
      const selectedId = activeTab.type === 'project'
        ? (activeTab.entityId || 'personal')
        : activeTab.type === 'all-tasks'
          ? 'all'
          : activeTab.type
      const selectedType = activeTab.type === 'project' ? 'project' : 'view'

      return (
        <TasksPage
          selectedId={selectedId}
          selectedType={selectedType}
          tasks={tasks}
          projects={projects}
          onTasksChange={onTasksChange}
          onSelectionChange={onSelectionChange}
          selectedTaskIds={selectedTaskIds}
          onSelectedTaskIdsChange={onSelectedTaskIdsChange}
        />
      )
    }
    default:
      // Placeholder for other tab types
      return (
        <div className="flex items-center justify-center h-full text-gray-500">
          <div className="text-center">
            <p className="text-lg font-medium">{activeTab.title}</p>
            <p className="text-sm">Tab type: {activeTab.type}</p>
          </div>
        </div>
      )
  }
}

// =============================================================================
// MAIN APP CONTENT (inside TabProvider)
// =============================================================================

interface AppContentProps {
  tasks: Task[]
  projects: Project[]
  selectedTaskIds: Set<string>
  onTasksChange: (tasks: Task[]) => void
  onSelectionChange: (id: string, type: TaskSelectionType) => void
  onSelectedTaskIdsChange: (ids: Set<string>) => void
}

const AppContent = ({
  tasks,
  projects,
  selectedTaskIds,
  onTasksChange,
  onSelectionChange,
  onSelectedTaskIdsChange,
}: AppContentProps): React.JSX.Element => {
  const { state } = useTabs()
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false)

  // Keyboard shortcuts
  useTabKeyboardShortcuts()
  const isChordActive = useChordShortcuts()

  // Get active group for tab bar
  const activeGroupId = state.activeGroupId
  const groupIds = Object.keys(state.tabGroups)
  const isSplitView = groupIds.length > 1

  // Calculate ordered group widths from layout (syncs with split panel ratios)
  const orderedGroupWidths = useMemo(
    () => getOrderedGroupWidths(state.layout),
    [state.layout]
  )

  return (
    <TabDragProvider>
      {/* Header with Tab Bar(s) */}
      <header className="drag-region flex h-10 shrink-0 items-center border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800">
        {/* Sidebar trigger */}
        <div className="flex items-center gap-2 px-2 h-full shrink-0">
          <SidebarTrigger className="-ml-1 no-drag" />
          <Separator
            orientation="vertical"
            className="mr-2 data-[orientation=vertical]:h-4"
          />
        </div>

        {/* Tab Bar(s) - single or split */}
        {isSplitView ? (
          // Split view: show tab bars side by side with divider, widths synced with split panel ratios
          <div className="flex-1 flex h-full">
            {orderedGroupWidths.map(({ groupId, width }, index) => (
              <div
                key={groupId}
                style={{ width: `${width}%` }}
                className={`h-full overflow-hidden shrink-0 ${index > 0 ? 'border-l border-gray-300 dark:border-gray-600' : ''
                  }`}
              >
                <TabBarWithDrag groupId={groupId} />
              </div>
            ))}
          </div>
        ) : (
          // Single pane: show one tab bar
          <div className="flex-1 h-full overflow-hidden">
            <TabBarWithDrag groupId={activeGroupId} />
          </div>
        )}

        {/* Global Actions */}
        <div className="flex items-center gap-1 px-2 shrink-0">
          <RecentlyClosedMenu />
          <button
            type="button"
            onClick={() => setShowShortcutsDialog(true)}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"
            title="Keyboard shortcuts (?)"
          >
            <span className="text-xs font-mono">?</span>
          </button>
        </div>
      </header>

      {/* Main Content Area - Split View or Single Pane */}
      <div className="flex flex-1 overflow-hidden" id="main-content">
        {isSplitView ? (
          // Multiple panes - use SplitViewContainer with matching header spacers
          <>
            {/* Left spacer - matches header's sidebar trigger area for alignment */}
            <div className="flex items-center gap-2 px-2 shrink-0" aria-hidden="true">
              <div className="size-7 -ml-1" />
              <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4 invisible" />
            </div>

            {/* Split view container */}
            <div className="flex-1 flex flex-col overflow-hidden min-w-0">
              <SplitViewContainer hideTabBars />
            </div>

            {/* Right spacer - matches header's global actions area for alignment */}
            <div className="flex items-center gap-1 px-2 shrink-0" aria-hidden="true">
              <div className="size-8" />
              <div className="size-8" />
            </div>
          </>
        ) : (
          // Single pane - render content directly (full width)
          <div className="flex-1 flex flex-col overflow-hidden">
            <TabContentRenderer
              tasks={tasks}
              projects={projects}
              selectedTaskIds={selectedTaskIds}
              onTasksChange={onTasksChange}
              onSelectionChange={onSelectionChange}
              onSelectedTaskIdsChange={onSelectedTaskIdsChange}
            />
          </div>
        )}
      </div>

      {/* Chord Indicator */}
      <ChordIndicator isActive={isChordActive} />

      {/* Keyboard Shortcuts Dialog */}
      <KeyboardShortcutsDialog
        isOpen={showShortcutsDialog}
        onClose={() => setShowShortcutsDialog(false)}
      />
    </TabDragProvider>
  )
}

// =============================================================================
// MAIN APP COMPONENT
// =============================================================================

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

  // Tasks page needs DragProvider
  const isTasksPage = currentPage === "tasks"

  // Main content with TabProvider and TasksProvider wrapping everything
  const mainContent = (
    <TasksProvider
      initialTasks={tasks}
      initialProjects={projectsWithCounts}
      onTasksChange={handleTasksChange}
      onProjectsChange={handleProjectsChange}
    >
      <TabProvider>
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
        <SidebarInset className="flex flex-col">
          <AppContent
            tasks={tasks}
            projects={projectsWithCounts}
            selectedTaskIds={selectedTaskIds}
            onTasksChange={handleTasksChange}
            onSelectionChange={handleTaskSelectionChange}
            onSelectedTaskIdsChange={handleSelectionChange}
          />
        </SidebarInset>
        {/* Drag Overlay - only for task drag to sidebar */}
        {isTasksPage && <TaskDragOverlay projects={projectsWithCounts} />}
      </TabProvider>
    </TasksProvider>
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
            {mainContent}
          </DragProvider>
        ) : (
          mainContent
        )}
      </SidebarProvider>
      <Toaster />
    </>
  )
}

export default App
