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
import { Inbox2Page } from "@/pages/inbox2"
import { JournalPage } from "@/pages/journal"
import { TasksPage } from "@/pages/tasks"
import { NotePage } from "@/pages/note"
import { DragProvider, type DragState } from "@/contexts/drag-context"
import { TaskDragOverlay } from "@/components/tasks/drag-drop"
import { initialProjects, taskViews, type Project } from "@/data/tasks-data"
import { sampleTasks, type Task } from "@/data/sample-tasks"
import { getFilteredTasks } from "@/lib/task-utils"
import { ThemeProvider } from "next-themes"


// Tab System imports
import { TabProvider, useTabs, useActiveTab, getOrderedGroupWidths } from "@/contexts/tabs"
import { TasksProvider } from "@/contexts/tasks"
import { TabBarWithDrag, RecentlyClosedMenu, TabDragProvider } from "@/components/tabs"
import { SplitViewContainer } from "@/components/split-view"
import { ChordIndicator, KeyboardShortcutsDialog } from "@/components/keyboard"
import { useTabKeyboardShortcuts, useChordShortcuts, useDragHandlers, useTaskOrder } from "@/hooks"

// Base pages (non-task)
export type BasePage = "inbox" | "inbox2" | "home" | "journal"

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
    case "inbox2":
      return <Inbox2Page />
    // New unified tasks tab type
    case "tasks":
      return (
        <TasksPage
          selectedId="all"
          selectedType="view"
          tasks={tasks}
          projects={projects}
          onTasksChange={onTasksChange}
          onSelectionChange={onSelectionChange}
          selectedTaskIds={selectedTaskIds}
          onSelectedTaskIdsChange={onSelectedTaskIdsChange}
        />
      )
    // Legacy task tab types (kept for backwards compatibility)
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
    case "journal":
      return <JournalPage />
    case "note":
      return <NotePage noteId={activeTab.entityId} />
    case "home":

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
  // Note: setCurrentPage is unused because navigation is now handled by tabs
  // currentPage is still used for sidebar highlight state
  const [currentPage, _setCurrentPage] = useState<AppPage>("inbox")

  // Task-related state (lifted from TasksPage)
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

  // Task handlers (passed to TasksPage)
  const handleTasksChange = useCallback((newTasks: Task[]): void => {
    setTasks(newTasks)
  }, [])

  const handleProjectsChange = useCallback((newProjects: Project[]): void => {
    setProjects(newProjects)
  }, [])

  // Task order persistence hook
  const taskOrder = useTaskOrder({ persist: true })

  // Task update handler
  const handleUpdateTask = useCallback((taskId: string, updates: Partial<Task>) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, ...updates } : t))
    )
  }, [])

  // Task delete handler
  const handleDeleteTask = useCallback((taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId))
  }, [])

  // Use the comprehensive drag handlers hook
  const { handleDragEnd: taskDragEnd } = useDragHandlers({
    tasks,
    projects,
    onUpdateTask: handleUpdateTask,
    onDeleteTask: handleDeleteTask,
    onReorder: (sectionId, taskIdsPair) => {
      // taskIdsPair is [activeId, overId] from the drag operation
      const [activeId, overId] = taskIdsPair
      taskOrder.reorderByDrag(sectionId, activeId, overId, tasks)
    },
  })

  // Combined drag-drop handler (task operations + project reordering)
  const handleDragEnd = useCallback(
    (event: DragEndEvent, dragState: DragState) => {
      const { active, over } = event
      if (!over) return

      const activeData = active.data.current

      // Handle project reordering in sidebar (not handled by useDragHandlers)
      if (activeData?.type === undefined && over.id !== active.id) {
        const activeIndex = projects.findIndex((p) => p.id === active.id)
        const overIndex = projects.findIndex((p) => p.id === over.id)
        if (activeIndex !== -1 && overIndex !== -1) {
          setProjects((prev) => arrayMove(prev, activeIndex, overIndex))
          return
        }
      }

      // Delegate all task operations to useDragHandlers
      taskDragEnd(event, dragState)

      // Clear selection after task drag
      if (dragState.isDragging) {
        setSelectedTaskIds(new Set())
      }
    },
    [projects, taskDragEnd]
  )

  // Update selection from TasksPage
  const handleSelectionChange = useCallback((ids: Set<string>): void => {
    setSelectedTaskIds(ids)
  }, [])

  // Task selection is now handled internally by TasksPage via internal tabs
  // This callback is kept for interface compatibility but is a no-op
  const handleTaskSelectionChange = useCallback((_id: string, _type: TaskSelectionType): void => {
    // No-op - internal tabs manage selection now
  }, [])

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
          viewCounts={viewCounts}
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
        <TaskDragOverlay projects={projectsWithCounts} />
      </TabProvider>
    </TasksProvider>
  )

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      <SidebarProvider>
        <DragProvider
          tasks={tasks}
          selectedIds={selectedTaskIds}
          onDragEnd={handleDragEnd}
        >
          {mainContent}
        </DragProvider>
      </SidebarProvider>
      <Toaster />
    </ThemeProvider>
  )
}

export default App
