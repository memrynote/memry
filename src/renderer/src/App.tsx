import { useState, useMemo, useCallback } from 'react'
import type { DragEndEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { AppSidebar } from '@/components/app-sidebar'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { DragProvider, type DragState } from '@/contexts/drag-context'
import { AIAgentProvider } from '@/contexts/ai-agent-context'
import { GlobalAIPanel } from '@/components/ai-agent'
import { TaskDragOverlay } from '@/components/tasks/drag-drop'
import { initialProjects, taskViews, type Project } from '@/data/tasks-data'
import { sampleTasks, type Task } from '@/data/sample-tasks'
import { getFilteredTasks } from '@/lib/task-utils'
import { ThemeProvider } from 'next-themes'

// Tab System imports
import { TabProvider, useTabs, getOrderedGroupWidths } from '@/contexts/tabs'
import { useTabPersistence, useSessionRestore } from '@/contexts/tabs/persistence'
import { TasksProvider } from '@/contexts/tasks'
import { TabBarWithDrag, TabDragProvider, TabErrorBoundary } from '@/components/tabs'
import { SplitViewContainer, SinglePaneContent } from '@/components/split-view'
import { ChordIndicator, KeyboardShortcutsDialog } from '@/components/keyboard'
import { SearchModal } from '@/components/search'
import {
  useTabKeyboardShortcuts,
  useChordShortcuts,
  useDragHandlers,
  useTaskOrder,
  useVault,
  useSearchShortcut,
  useNewNoteShortcut,
  useUndoKeyboardShortcut,
  useReminderNotifications
} from '@/hooks'
import { useFolderViewEvents } from '@/hooks/use-folder-view-events'
import { tasksService } from '@/services/tasks-service'
import { notesService } from '@/services/notes-service'
import { VaultOnboarding } from '@/components/vault-onboarding'

// Base pages (non-task)
export type BasePage = 'inbox' | 'home' | 'journal'

// Task view type for navigation within tasks
export type TaskViewId = 'all' | 'today' | 'upcoming' | 'completed'

// Selection type for tasks page
export type TaskSelectionType = 'view' | 'project'

// Combined page type for routing
export type AppPage = BasePage | 'tasks'

// =============================================================================
// TAB PERSISTENCE MANAGER (inside TabProvider)
// =============================================================================

/**
 * Component that enables tab session persistence.
 * Must be rendered inside TabProvider.
 */
function TabPersistenceManager({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Auto-save tab state on changes (debounced)
  useTabPersistence()

  // Restore session on mount
  useSessionRestore()

  return <>{children}</>
}

// =============================================================================
// MAIN APP CONTENT (inside TabProvider)
// =============================================================================

interface AppContentProps {
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
}

const AppContent = ({ searchOpen, onSearchOpenChange }: AppContentProps): React.JSX.Element => {
  const { state, openTab } = useTabs()
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false)

  // Handle creating a new note
  const handleNewNote = useCallback(async () => {
    try {
      const result = await notesService.create({
        title: 'Untitled',
        content: ''
      })

      if (result.success && result.note) {
        openTab({
          type: 'note',
          title: result.note.title || 'Untitled',
          icon: 'file-text',
          path: `/note/${result.note.id}`,
          entityId: result.note.id,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        })
      }
    } catch (error) {
      console.error('Failed to create new note:', error)
    }
  }, [openTab])

  // Keyboard shortcuts
  useTabKeyboardShortcuts()
  const isChordActive = useChordShortcuts()
  useSearchShortcut(() => onSearchOpenChange(true))
  useNewNoteShortcut(handleNewNote)
  useUndoKeyboardShortcut() // T051-T054: Cmd+Z for task undo
  useReminderNotifications() // T231-T233: In-app toast notifications for reminders
  useFolderViewEvents() // Global cache invalidation for folder-view tabs

  // Handle search result selection - open note or journal in appropriate tab
  const handleSelectSearchResult = useCallback(
    (noteId: string, path: string) => {
      // Check if this is a journal entry (pattern: journal/YYYY-MM-DD.md)
      const journalDateMatch = path.match(/^journal\/(\d{4}-\d{2}-\d{2})\.md$/)

      if (journalDateMatch) {
        // Open journal tab with the specific date
        const date = journalDateMatch[1]
        openTab({
          type: 'journal',
          title: 'Journal',
          icon: 'book-open',
          path: '/journal',
          entityId: undefined,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false,
          viewState: { date }
        })
      } else {
        // Regular note - open in note tab
        openTab({
          type: 'note',
          title: 'Note', // Will be updated when note loads
          icon: 'file-text',
          path: `/note/${noteId}`,
          entityId: noteId,
          isPinned: false,
          isModified: false,
          isPreview: true,
          isDeleted: false
        })
      }
      onSearchOpenChange(false)
    },
    [openTab, onSearchOpenChange]
  )

  // Get active group for tab bar
  const activeGroupId = state.activeGroupId
  const groupIds = Object.keys(state.tabGroups)
  const isSplitView = groupIds.length > 1

  // Calculate ordered group widths from layout (syncs with split panel ratios)
  const orderedGroupWidths = useMemo(() => getOrderedGroupWidths(state.layout), [state.layout])

  return (
    <TabDragProvider>
      {/* Header with Tab Bar(s) */}
      <header className="drag-region flex h-10 shrink-0 items-center border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800">
        {/* Sidebar trigger */}
        <div className="flex items-center gap-2 px-2 h-full shrink-0">
          <SidebarTrigger className="-ml-1 no-drag" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
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
              <Separator
                orientation="vertical"
                className="mr-2 data-[orientation=vertical]:h-4 invisible"
              />
            </div>

            {/* Split view container */}
            <div className="flex-1 flex flex-col overflow-hidden min-w-0">
              <SplitViewContainer hideTabBars />
            </div>
          </>
        ) : (
          // Single pane - render content directly (full width)
          <div className="flex-1 flex flex-col overflow-hidden">
            <SinglePaneContent />
          </div>
        )}

        {/* Global AI Agent Panel - pushes content when open */}
        <GlobalAIPanel />
      </div>

      {/* Chord Indicator */}
      <ChordIndicator isActive={isChordActive} />

      {/* Keyboard Shortcuts Dialog */}
      <KeyboardShortcutsDialog
        isOpen={showShortcutsDialog}
        onClose={() => setShowShortcutsDialog(false)}
      />

      {/* Search Modal */}
      <SearchModal
        isOpen={searchOpen}
        onClose={() => onSearchOpenChange(false)}
        onSelectNote={handleSelectSearchResult}
      />
    </TabDragProvider>
  )
}

// =============================================================================
// MAIN APP COMPONENT
// =============================================================================

function App(): React.JSX.Element {
  // Vault state - check if vault is open
  const { status: vaultStatus, isLoading: vaultLoading } = useVault()
  const isVaultOpen = vaultStatus?.isOpen ?? false

  // Navigation state
  // Note: setCurrentPage is unused because navigation is now handled by tabs
  // currentPage is still used for sidebar highlight state
  const [currentPage, _setCurrentPage] = useState<AppPage>('inbox')

  // Task-related state (lifted from TasksPage)
  const [projects, setProjects] = useState<Project[]>(initialProjects)
  const [tasks, setTasks] = useState<Task[]>(sampleTasks)

  // Task selection state for drag-drop (lifted from TasksPage)
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())

  // Search modal state
  const [searchOpen, setSearchOpen] = useState(false)

  // Calculate view counts dynamically
  const viewCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    taskViews.forEach((view) => {
      const filtered = getFilteredTasks(tasks, view.id, 'view', projects)
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
        return status?.type !== 'done'
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

  // Priority conversion map (UI string → DB number)
  const priorityReverseMap: Record<Task['priority'], number> = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
    urgent: 4
  }

  // Task update handler - persists to database when vault is open
  const handleUpdateTask = useCallback(
    async (taskId: string, updates: Partial<Task>) => {
      // Always update local state immediately for responsive UI
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...updates } : t)))

      // Persist to database if vault is open
      if (isVaultOpen) {
        try {
          // Handle completedAt changes via dedicated endpoints
          if ('completedAt' in updates) {
            if (updates.completedAt !== null && updates.completedAt !== undefined) {
              await tasksService.complete({
                id: taskId,
                completedAt: updates.completedAt.toISOString()
              })
            } else {
              await tasksService.uncomplete(taskId)
            }

            // Handle other updates if present
            const { completedAt: _completed, ...otherUpdates } = updates
            if (Object.keys(otherUpdates).length > 0) {
              let dueDateValue: string | null | undefined = undefined
              if ('dueDate' in otherUpdates) {
                dueDateValue = otherUpdates.dueDate
                  ? otherUpdates.dueDate.toISOString().split('T')[0]
                  : null
              }
              await tasksService.update({
                id: taskId,
                title: otherUpdates.title,
                description: otherUpdates.description ?? undefined,
                priority:
                  otherUpdates.priority !== undefined
                    ? priorityReverseMap[otherUpdates.priority]
                    : undefined,
                projectId: otherUpdates.projectId,
                statusId: otherUpdates.statusId ?? undefined,
                dueDate: dueDateValue,
                dueTime: otherUpdates.dueTime ?? undefined
              })
            }
            return
          }

          // Handle archivedAt changes via dedicated endpoints
          if ('archivedAt' in updates) {
            if (updates.archivedAt !== null && updates.archivedAt !== undefined) {
              await tasksService.archive(taskId)
            } else {
              await tasksService.unarchive(taskId)
            }

            // Handle other updates if present
            const { archivedAt: _archived, ...otherUpdates } = updates
            if (Object.keys(otherUpdates).length > 0) {
              let dueDateValue: string | null | undefined = undefined
              if ('dueDate' in otherUpdates) {
                dueDateValue = otherUpdates.dueDate
                  ? otherUpdates.dueDate.toISOString().split('T')[0]
                  : null
              }
              await tasksService.update({
                id: taskId,
                title: otherUpdates.title,
                description: otherUpdates.description ?? undefined,
                priority:
                  otherUpdates.priority !== undefined
                    ? priorityReverseMap[otherUpdates.priority]
                    : undefined,
                projectId: otherUpdates.projectId,
                statusId: otherUpdates.statusId ?? undefined,
                dueDate: dueDateValue,
                dueTime: otherUpdates.dueTime ?? undefined
              })
            }
            return
          }

          // Standard update (no completedAt or archivedAt change)
          // Convert dueDate: undefined = not changing, null = clearing, Date = setting
          let dueDateValue: string | null | undefined = undefined
          if ('dueDate' in updates) {
            dueDateValue = updates.dueDate ? updates.dueDate.toISOString().split('T')[0] : null
          }

          await tasksService.update({
            id: taskId,
            title: updates.title,
            description: updates.description ?? undefined,
            priority:
              updates.priority !== undefined ? priorityReverseMap[updates.priority] : undefined,
            projectId: updates.projectId,
            statusId: updates.statusId ?? undefined,
            dueDate: dueDateValue,
            dueTime: updates.dueTime ?? undefined
          })
        } catch (error) {
          console.error('[App] Failed to persist task update:', error)
          // Local state already updated, error will be visible in logs
        }
      }
    },
    [isVaultOpen]
  )

  // Task delete handler - persists to database when vault is open
  const handleDeleteTask = useCallback(
    async (taskId: string) => {
      // Always update local state immediately for responsive UI
      setTasks((prev) => prev.filter((t) => t.id !== taskId))

      // Persist to database if vault is open
      if (isVaultOpen) {
        try {
          await tasksService.delete(taskId)
        } catch (error) {
          console.error('[App] Failed to persist task deletion:', error)
        }
      }
    },
    [isVaultOpen]
  )

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
    }
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

  // Main content with TabProvider and TasksProvider wrapping everything
  // Wrapped in TabErrorBoundary for graceful error handling
  const mainContent = (
    <TabErrorBoundary
      onError={(error, errorInfo) => console.error('[App] Critical error:', error, errorInfo)}
    >
      <TasksProvider
        initialTasks={tasks}
        initialProjects={projectsWithCounts}
        onTasksChange={handleTasksChange}
        onProjectsChange={handleProjectsChange}
      >
        <AIAgentProvider>
          <TabProvider>
            <TabPersistenceManager>
              <AppSidebar
                currentPage={currentPage}
                viewCounts={viewCounts}
                onOpenSearch={() => setSearchOpen(true)}
              />
              <SidebarInset className="flex flex-col">
                <AppContent searchOpen={searchOpen} onSearchOpenChange={setSearchOpen} />
              </SidebarInset>
              {/* Drag Overlay - only for task drag to sidebar */}
              <TaskDragOverlay projects={projectsWithCounts} />
            </TabPersistenceManager>
          </TabProvider>
        </AIAgentProvider>
      </TasksProvider>
    </TabErrorBoundary>
  )

  // Show onboarding if no vault is open (and not still loading)
  if (!vaultLoading && !isVaultOpen) {
    return (
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
        <VaultOnboarding />
        <Toaster />
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      <SidebarProvider>
        <DragProvider tasks={tasks} selectedIds={selectedTaskIds} onDragEnd={handleDragEnd}>
          {mainContent}
        </DragProvider>
      </SidebarProvider>
      <Toaster />
    </ThemeProvider>
  )
}

export default App
