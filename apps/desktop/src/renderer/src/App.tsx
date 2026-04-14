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
import { AIInlineProvider } from '@/contexts/ai-inline-context'
import { DayPanelProvider } from '@/contexts/day-panel-context'
import { SidebarDrillDownProvider } from '@/contexts/sidebar-drill-down'
import { SelectedFolderProvider } from '@/contexts/selected-folder-context'
import { GlobalDayPanel } from '@/components/day-panel'
import { TaskDragOverlay } from '@/components/tasks/drag-drop'
import { taskViews } from '@/data/tasks-data'
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
  useSearchShortcut,
  useHintActivation
} from '@/hooks'
import { HintModeProvider } from '@/contexts/hint-mode'
import { HintOverlay, HintIndicator } from '@/components/hint-overlay'
import { CommandPalette } from '@/components/search/command-palette'
import { SettingsModalProvider, useSettingsModal } from '@/contexts/settings-modal-context'
import { SettingsModal } from '@/components/settings-modal'
import { useFolderViewEvents } from '@/hooks/use-folder-view-events'
import { useFlushOnQuit } from '@/hooks/use-flush-on-quit'
import { tasksService, queueTaskReorder } from '@/services/tasks-service'
import { notesService } from '@/services/notes-service'
import { VaultOnboarding } from '@/components/vault-onboarding'
import { FirstRunOnboarding } from '@/components/first-run-onboarding'
import { useThemeSync } from '@/hooks/use-theme-sync'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { createLogger } from '@/lib/logger'
import { getStartupTheme, THEME_STORAGE_KEY } from '@/lib/startup-theme'
import { useTaskWorkspaceData, useTaskWorkspaceMutations } from '@/features/tasks/use-task-queries'
import { useTaskUiStore } from '@/features/tasks/use-task-ui-store'
import { getFilteredTasks } from '@/lib/task-utils'

const log = createLogger('App')
const startupTheme = getStartupTheme()

// Base pages (non-task)
export type BasePage = 'inbox' | 'journal' | 'calendar' | 'graph'

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
  const { open: openSettings } = useSettingsModal()
  useSettingsShortcut(openSettings)
  useNewNoteShortcut(() => void handleNewNote())
  useUndoKeyboardShortcut() // T051-T054: Cmd+Z for task undo
  useReminderNotifications() // T231-T233: In-app toast notifications for reminders
  useFolderViewEvents() // Global cache invalidation for folder-view tabs
  const toggleSearch = useCallback(() => setSearchOpen((prev) => !prev), [])
  useSearchShortcut(toggleSearch)
  useHintActivation()

  useEffect(() => {
    const openSearch = () => setSearchOpen(true)
    window.addEventListener('memry:open-search', openSearch)
    return () => window.removeEventListener('memry:open-search', openSearch)
  }, [])

  useEffect(() => {
    const openTestNote = (
      event: CustomEvent<{ id?: string; title?: string; emoji?: string | null }>
    ) => {
      const { id, title, emoji } = event.detail ?? {}
      if (!id || !title) return

      openTab({
        type: 'note',
        title,
        icon: 'file-text',
        emoji: emoji ?? undefined,
        path: `/notes/${id}`,
        entityId: id,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    }

    window.addEventListener('memry:test-open-note', openTestNote as EventListener)
    return () => window.removeEventListener('memry:test-open-note', openTestNote as EventListener)
  }, [openTab])

  useEffect(() => {
    return window.api.onSettingsOpenRequested((section) => {
      openSettings(section)
    })
  }, [openSettings])

  return (
    <TabDragProvider>
      <div className="flex flex-1 overflow-hidden bg-background" id="main-content">
        <SplitViewContainer />
      </div>
      <GlobalDayPanel />

      {/* Chord Indicator */}
      <ChordIndicator isActive={isChordActive} />

      {/* Hint Mode Overlay + Indicator */}
      <HintOverlay />
      <HintIndicator />

      {/* Keyboard Shortcuts Dialog */}
      <KeyboardShortcutsDialog
        isOpen={showShortcutsDialog}
        onClose={() => setShowShortcutsDialog(false)}
      />

      {/* Global Search Command Palette */}
      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />

      {/* Settings Modal */}
      <SettingsModal />
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
      localStorage.removeItem('sidebar-tree-expanded')
      log.info('Vault switched, cleared query cache and tab state')
    }
    prevVaultPathRef.current = vaultPath
  }, [vaultPath, queryClient])

  // Navigation state
  // Note: navigation is now handled by tabs
  // currentPage is still used for sidebar highlight state
  const [currentPage] = useState<AppPage>('inbox')

  const { tasks, projects } = useTaskWorkspaceData({ enabled: isVaultOpen })
  const {
    setProjects,
    updateTask: handleUpdateTask,
    deleteTask: handleDeleteTask
  } = useTaskWorkspaceMutations()
  const { selectedTaskIds, setSelectedTaskIds: updateSelectedTaskIds } = useTaskUiStore()
  const selectedTaskIdsRef = useRef(selectedTaskIds)

  useEffect(() => {
    selectedTaskIdsRef.current = selectedTaskIds
  }, [selectedTaskIds])

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

  const taskOrder = useTaskOrder({ persist: true })

  const handleReorder = useCallback(
    (updates: Record<string, string[] | null>) => {
      taskOrder.applyOrderUpdates(updates)
      for (const [, taskIds] of Object.entries(updates)) {
        if (!taskIds) continue
        const positions = taskIds.map((_, i) => i)
        queueTaskReorder(taskIds, positions)
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
          setProjects((prev) => {
            const reorderedProjects = arrayMove(prev, activeIndex, overIndex)
            void tasksService.reorderProjects(
              reorderedProjects.map((project) => project.id),
              reorderedProjects.map((_, index) => index)
            )
            return reorderedProjects
          })
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
    [projects, setProjects, taskDragEnd, updateSelectedTaskIds]
  )

  // Main content with TabProvider and TasksProvider wrapping everything
  // Wrapped in TabErrorBoundary for graceful error handling
  const mainContent = (
    <TabErrorBoundary
      onError={(error, errorInfo) => log.error('Critical error:', error, errorInfo)}
    >
      <TasksProvider
        tasks={tasks}
        projects={projectsWithCounts}
        getOrderedTasks={taskOrder.getOrderedTasks}
      >
        <DayPanelProvider>
          <AIInlineProvider>
            <HintModeProvider>
              <TabProvider>
                <TabPersistenceManager>
                  <SettingsModalProvider>
                    <SelectedFolderProvider>
                      <SidebarDrillDownProvider>
                        <AppSidebar currentPage={currentPage} viewCounts={viewCounts} />
                        <SidebarInset className="flex flex-col overflow-hidden">
                          <AppContent />
                        </SidebarInset>
                      </SidebarDrillDownProvider>
                      <TaskDragOverlay projects={projectsWithCounts} />
                    </SelectedFolderProvider>
                  </SettingsModalProvider>
                </TabPersistenceManager>
              </TabProvider>
            </HintModeProvider>
          </AIInlineProvider>
        </DayPanelProvider>
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
