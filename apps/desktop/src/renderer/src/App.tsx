import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { DragEndEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from '@/lib/icons'
import { AppSidebar } from '@/components/app-sidebar'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { DragProvider, type DragState } from '@/contexts/drag-context'
import { DroppedPriorityProvider } from '@/contexts/dropped-priority-context'
import { AIAgentProvider } from '@/contexts/ai-agent-context'
import { AIInlineProvider } from '@/contexts/ai-inline-context'
import { SidebarDrillDownProvider } from '@/contexts/sidebar-drill-down'
import { GlobalAIPanel } from '@/components/ai-agent'
import { TaskDragOverlay } from '@/components/tasks/drag-drop'
import { initialProjects, taskViews, type Project } from '@/data/tasks-data'
import { sampleTasks, type Task } from '@/data/sample-tasks'
import { getFilteredTasks, formatDateKey } from '@/lib/task-utils'
import { ThemeProvider } from 'next-themes'

// Tab System imports
import { TabProvider, useTabs } from '@/contexts/tabs'
import { useTabPersistence, useSessionRestore, STORAGE_KEY } from '@/contexts/tabs/persistence'
import { TasksProvider } from '@/contexts/tasks'
import { TabDragProvider, TabErrorBoundary } from '@/components/tabs'
import { SplitViewContainer } from '@/components/split-view'
import { ChordIndicator, KeyboardShortcutsDialog } from '@/components/keyboard'
import {
  useTabKeyboardShortcuts,
  useChordShortcuts,
  useDragHandlers,
  useTaskOrder,
  useVault,
  useSettingsShortcut,
  useNewNoteShortcut,
  useUndoKeyboardShortcut,
  useReminderNotifications,
  useSearchShortcut
} from '@/hooks'
import { CommandPalette } from '@/components/search/command-palette'
import { useFolderViewEvents } from '@/hooks/use-folder-view-events'
import { useFlushOnQuit } from '@/hooks/use-flush-on-quit'
import { tasksService } from '@/services/tasks-service'
import { notesService } from '@/services/notes-service'
import { VaultOnboarding } from '@/components/vault-onboarding'
import { FirstRunOnboarding } from '@/components/first-run-onboarding'
import { useThemeSync } from '@/hooks/use-theme-sync'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { createLogger } from '@/lib/logger'
import { getStartupTheme, THEME_STORAGE_KEY } from '@/lib/startup-theme'

const log = createLogger('App')
const startupTheme = getStartupTheme()

// Base pages (non-task)
export type BasePage = 'inbox' | 'home' | 'journal' | 'graph'

// Task view type for navigation within tasks
export type TaskViewId = 'all' | 'today' | 'completed'

// Selection type for tasks page
export type TaskSelectionType = 'view' | 'project'

// Combined page type for routing
export type AppPage = BasePage | 'tasks'

// =============================================================================
// THEME SYNC MANAGER (inside ThemeProvider)
// =============================================================================

function ThemeSyncManager({ children }: { children: React.ReactNode }): React.JSX.Element {
  useThemeSync()
  return <>{children}</>
}

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

const AppContent = (): React.JSX.Element => {
  const { openTab } = useTabs()
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

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
      log.error('Failed to create new note:', error)
    }
  }, [openTab])

  // Keyboard shortcuts
  useTabKeyboardShortcuts()
  const isChordActive = useChordShortcuts()
  useSettingsShortcut(() => {
    openTab({
      type: 'settings',
      title: 'Settings',
      icon: 'settings',
      path: '/settings',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
  })
  useNewNoteShortcut(() => void handleNewNote())
  useUndoKeyboardShortcut() // T051-T054: Cmd+Z for task undo
  useReminderNotifications() // T231-T233: In-app toast notifications for reminders
  useFolderViewEvents() // Global cache invalidation for folder-view tabs
  const toggleSearch = useCallback(() => setSearchOpen((prev) => !prev), [])
  useSearchShortcut(toggleSearch)

  useEffect(() => {
    const openSearch = () => setSearchOpen(true)
    window.addEventListener('memry:open-search', openSearch)
    return () => window.removeEventListener('memry:open-search', openSearch)
  }, [])

  return (
    <TabDragProvider>
      <div className="flex flex-1 overflow-hidden bg-background" id="main-content">
        <SplitViewContainer />
        <GlobalAIPanel />
      </div>

      {/* Chord Indicator */}
      <ChordIndicator isActive={isChordActive} />

      {/* Keyboard Shortcuts Dialog */}
      <KeyboardShortcutsDialog
        isOpen={showShortcutsDialog}
        onClose={() => setShowShortcutsDialog(false)}
      />

      {/* Global Search Command Palette */}
      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
    </TabDragProvider>
  )
}

// =============================================================================
// MAIN APP COMPONENT
// =============================================================================

function App(): React.JSX.Element {
  // Flush pending saves when main process requests it (Cmd+Q, window close)
  useFlushOnQuit()

  // Vault state - check if vault is open
  const { status: vaultStatus, isLoading: vaultLoading } = useVault()
  const isVaultOpen = vaultStatus?.isOpen ?? false
  const vaultPath = vaultStatus?.path ?? null
  const queryClient = useQueryClient()

  // General settings — used to gate first-run onboarding
  const {
    settings: generalSettings,
    isLoading: generalSettingsLoading,
    updateSettings: updateGeneralSettings
  } = useGeneralSettings()

  const handleOnboardingComplete = useCallback(async () => {
    await updateGeneralSettings({ onboardingCompleted: true })
  }, [updateGeneralSettings])
  const prevVaultPathRef = useRef<string | null>(null)

  useEffect(() => {
    if (!vaultPath) return
    if (prevVaultPathRef.current && prevVaultPathRef.current !== vaultPath) {
      queryClient.clear()
      localStorage.removeItem(STORAGE_KEY)
      log.info('Vault switched, cleared query cache and tab state')
    }
    prevVaultPathRef.current = vaultPath
  }, [vaultPath, queryClient])

  // Navigation state
  // Note: navigation is now handled by tabs
  // currentPage is still used for sidebar highlight state
  const [currentPage] = useState<AppPage>('inbox')

  // Task-related state (lifted from TasksPage)
  const [projects, setProjects] = useState<Project[]>(initialProjects)
  const [tasks, setTasks] = useState<Task[]>(sampleTasks)

  // Task selection state for drag-drop (lifted from TasksPage)
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
  const selectedTaskIdsRef = useRef(selectedTaskIds)

  const updateSelectedTaskIds = useCallback((ids: Set<string>) => {
    selectedTaskIdsRef.current = ids
    setSelectedTaskIds(ids)
  }, [])

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
            const { completedAt: _, ...otherUpdates } = updates
            void _
            if (Object.keys(otherUpdates).length > 0) {
              let dueDateValue: string | null | undefined = undefined
              if ('dueDate' in otherUpdates) {
                dueDateValue = otherUpdates.dueDate ? formatDateKey(otherUpdates.dueDate) : null
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
            const { archivedAt: __, ...otherUpdates } = updates
            void __
            if (Object.keys(otherUpdates).length > 0) {
              let dueDateValue: string | null | undefined = undefined
              if ('dueDate' in otherUpdates) {
                dueDateValue = otherUpdates.dueDate ? formatDateKey(otherUpdates.dueDate) : null
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
            dueDateValue = updates.dueDate ? formatDateKey(updates.dueDate) : null
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
          log.error('Failed to persist task update:', error)
          // Local state already updated, error will be visible in logs
        }
      }
    },
    [isVaultOpen, priorityReverseMap]
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
          log.error('Failed to persist task deletion:', error)
        }
      }
    },
    [isVaultOpen]
  )

  const handleReorder = useCallback(
    (updates: Record<string, string[] | null>) => {
      taskOrder.applyOrderUpdates(updates)
      for (const [, taskIds] of Object.entries(updates)) {
        if (!taskIds) continue
        const positions = taskIds.map((_, i) => i)
        tasksService.reorder(taskIds, positions)
      }
    },
    [taskOrder]
  )

  // Use the comprehensive drag handlers hook
  const { handleDragEnd: taskDragEnd, droppedPriorities } = useDragHandlers({
    tasks,
    projects,
    onUpdateTask: handleUpdateTask,
    onDeleteTask: handleDeleteTask,
    onReorder: handleReorder,
    getOrder: taskOrder.getOrder
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
        updateSelectedTaskIds(new Set<string>())
      }
    },
    [projects, taskDragEnd, updateSelectedTaskIds]
  )

  // Main content with TabProvider and TasksProvider wrapping everything
  // Wrapped in TabErrorBoundary for graceful error handling
  const mainContent = (
    <TabErrorBoundary
      onError={(error, errorInfo) => log.error('Critical error:', error, errorInfo)}
    >
      <TasksProvider
        initialTasks={tasks}
        initialProjects={projectsWithCounts}
        onTasksChange={handleTasksChange}
        onProjectsChange={handleProjectsChange}
        selectedTaskIds={selectedTaskIds}
        onSelectedTaskIdsChange={updateSelectedTaskIds}
        getOrderedTasks={taskOrder.getOrderedTasks}
      >
        <AIAgentProvider>
          <AIInlineProvider>
            <TabProvider>
              <TabPersistenceManager>
                <SidebarDrillDownProvider>
                  <AppSidebar currentPage={currentPage} viewCounts={viewCounts} />
                  <SidebarInset className="flex flex-col overflow-hidden">
                    <AppContent />
                  </SidebarInset>
                </SidebarDrillDownProvider>
                {/* Drag Overlay - only for task drag to sidebar */}
                <TaskDragOverlay projects={projectsWithCounts} />
              </TabPersistenceManager>
            </TabProvider>
          </AIInlineProvider>
        </AIAgentProvider>
      </TasksProvider>
    </TabErrorBoundary>
  )

  if (vaultLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-sidebar-terracotta" />
      </div>
    )
  }

  if (!isVaultOpen) {
    return (
      <ThemeProvider
        attribute="class"
        defaultTheme={startupTheme}
        enableSystem
        themes={['light', 'dark', 'white', 'system']}
        storageKey={THEME_STORAGE_KEY}
      >
        <VaultOnboarding />
        <Toaster />
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme={startupTheme}
      enableSystem
      themes={['light', 'dark', 'white', 'system']}
      storageKey={THEME_STORAGE_KEY}
    >
      <ThemeSyncManager>
        <SidebarProvider key={vaultPath}>
          <DragProvider
            tasks={tasks}
            selectedIds={selectedTaskIds}
            selectedIdsRef={selectedTaskIdsRef}
            onDragEnd={(event, state) => void handleDragEnd(event, state)}
          >
            <DroppedPriorityProvider value={droppedPriorities}>
              {mainContent}
            </DroppedPriorityProvider>
          </DragProvider>
        </SidebarProvider>
        {/* First-run onboarding overlay — shown until user completes or dismisses */}
        {!generalSettingsLoading && !generalSettings.onboardingCompleted && (
          <FirstRunOnboarding onComplete={() => void handleOnboardingComplete()} />
        )}
        <Toaster />
      </ThemeSyncManager>
    </ThemeProvider>
  )
}

export default App
