import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { DragEndEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from '@/lib/icons'
import { AppSidebar } from '@/components/app-sidebar'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { WindowControls } from '@/components/window-controls'
import { Toaster } from '@/components/ui/sonner'
import { DragProvider, type DragState } from '@/contexts/drag-context'
import { DroppedPriorityProvider } from '@/contexts/dropped-priority-context'
import { AIInlineProvider } from '@/contexts/ai-inline-context'
import { AISettingsProvider, useAISettingsContext } from '@/contexts/ai-settings-context'
import { DayPanelProvider } from '@/contexts/day-panel-context'
import { CalendarViewProvider } from '@/contexts/calendar-view-context'
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
  useMouseNavButtons,
  useDragHandlers,
  useTaskOrder,
  useVault,
  useSettingsShortcut,
  useNewNoteShortcut,
  useUndoKeyboardShortcut,
  useReminderNotifications,
  useInboxReviewNotifications,
  useSearchShortcut,
  useHintActivation,
  isInputFocused
} from '@/hooks'
import { matchesShortcut } from '@/hooks/use-keyboard-shortcuts-base'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
import { HintModeProvider } from '@/contexts/hint-mode'
import { HintOverlay, HintIndicator } from '@/components/hint-overlay'
import { CommandPalette } from '@/components/search/command-palette'
import { SettingsModalProvider, useSettingsModal } from '@/contexts/settings-modal-context'
import { SettingsModal } from '@/components/settings-modal'
import { useFolderViewEvents } from '@/hooks/use-folder-view-events'
import { useCloseTabsOnEntityDelete } from '@/hooks/use-close-tabs-on-entity-delete'
import { useFlushOnQuit } from '@/hooks/use-flush-on-quit'
import { useMenuCommands } from '@/hooks/use-menu-commands'
import { tasksService, queueTaskReorder } from '@/services/tasks-service'
import { notesService } from '@/services/notes-service'
import { IncidentReportProvider } from '@/components/diagnostics/incident-report-provider'
import { VaultOnboarding } from '@/components/vault-onboarding'
import { UpdatingScreen } from '@/components/updating-screen'
import { UpdatePromptDialog } from '@/components/updater/update-prompt-dialog'
import { UpdateInstallFailedDialog } from '@/components/updater/update-install-failed-dialog'
import { GithubStarCard } from '@/components/onboarding/github-star-card'
import { UpdateReleaseNotesTabOpener } from '@/components/updater/update-release-notes-tab-opener'
import { ReleaseNotesDevTrigger } from '@/components/updater/release-notes-dev-trigger'
import { useAppUpdaterSelector } from '@/hooks/use-app-updater'
import { useThemeSync } from '@/hooks/use-theme-sync'
import { useWeekStartSync } from '@/hooks/use-week-start-sync'
import { trackTelemetry } from '@/lib/telemetry'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import type { TelemetrySurface } from '@memry/contracts/telemetry-api'
import { useActiveTab } from '@/contexts/tabs'
import type { TabType } from '@/contexts/tabs'
import { createLogger } from '@/lib/logger'
import { getStartupTheme, THEME_STORAGE_KEY } from '@/lib/startup-theme'
import { useTaskWorkspaceData, useTaskWorkspaceMutations } from '@/features/tasks/use-task-queries'
import { useTaskUiStore } from '@/features/tasks/use-task-ui-store'
import { getTaskWorkspaceCounts } from '@/lib/task-utils'
import { revealNoteInSidebar } from '@/lib/reveal-in-sidebar'
import { useAgentMcpCurrentNoteResponder } from '@/agent-mcp/current-note-handler'
import { useAgentMcpDesktopApiResponder } from '@/agent-mcp/desktop-api-handler'
import { useAgentMcpCanvasWriteResponder } from '@/agent-mcp/canvas-write-handler'
import { AgentFeatureProvider } from '@/agent-chat/agent-feature-provider'
import { AgentTabTitleSync } from '@/agent-chat/agent-tab-title-sync'

const log = createLogger('App')
const startupTheme = getStartupTheme()

// Base pages (non-task)
export type BasePage = 'inbox' | 'journal' | 'calendar' | 'graph'

// Task view type for navigation within tasks
export type TaskViewId = 'all' | 'today' | 'completed'

// Selection type for tasks page
export type TaskSelectionType = 'view' | 'project'

// Combined page type for routing
export type AppPage = BasePage | 'tasks' | 'home'

// Sidebar badge ids, hoisted so the count pass gets a stable input array.
const taskViewIds = taskViews.map((view) => view.id)

// =============================================================================
// THEME SYNC MANAGER (inside ThemeProvider)
// =============================================================================

function ThemeSyncManager({ children }: { children: React.ReactNode }): React.JSX.Element {
  useThemeSync()
  useWeekStartSync()
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

const TAB_TYPE_TO_SURFACE: Partial<Record<TabType, TelemetrySurface>> = {
  home: 'home',
  inbox: 'inbox',
  calendar: 'calendar',
  tasks: 'tasks',
  'all-tasks': 'tasks',
  today: 'tasks',
  completed: 'tasks',
  project: 'projects',
  note: 'notes',
  file: 'notes',
  folder: 'notes',
  collection: 'notes',
  'virtual-note': 'notes',
  'template-editor': 'notes',
  journal: 'journal',
  search: 'search',
  graph: 'graph',
  tags: 'tags',
  tag: 'tags',
  canvas: 'canvas',
  'agent-chat': 'ai'
}

const AppContent = (): React.JSX.Element => {
  const { openTab } = useTabs()
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  // Fire `page_viewed` whenever the active tab type changes. Only ever surface enums,
  // never tab titles, file paths, or note IDs.
  const activeTab = useActiveTab()
  const { enabled: aiEnabled } = useAISettingsContext()
  useAgentMcpCurrentNoteResponder({ enabled: aiEnabled })
  useAgentMcpDesktopApiResponder({ enabled: aiEnabled })
  useAgentMcpCanvasWriteResponder({ enabled: aiEnabled })
  const lastTrackedTabTypeRef = useRef<TabType | null>(null)
  useEffect(() => {
    if (!activeTab) return
    if (lastTrackedTabTypeRef.current === activeTab.type) return
    lastTrackedTabTypeRef.current = activeTab.type
    const surface = TAB_TYPE_TO_SURFACE[activeTab.type]
    if (!surface) return
    void trackTelemetry('page_viewed', { surface, action: 'viewed', objectType: activeTab.type })
  }, [activeTab])

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
        // Where the note landed is only knowable from the created note, so the
        // sidebar is told to reveal it rather than guessing at the folder.
        revealNoteInSidebar(result.note.id)
      }
    } catch (error) {
      log.error('Failed to create new note:', error)
    }
  }, [openTab])

  // Keyboard shortcuts
  useTabKeyboardShortcuts()
  useMouseNavButtons()
  const isChordActive = useChordShortcuts()
  const { open: openSettings } = useSettingsModal()
  useSettingsShortcut(openSettings)
  useNewNoteShortcut(() => void handleNewNote())
  useUndoKeyboardShortcut() // T051-T054: Cmd+Z for task undo
  useReminderNotifications() // T231-T233: In-app toast notifications for reminders
  useInboxReviewNotifications() // Daily inbox review nudge: toast + open-inbox on click
  useFolderViewEvents() // Global cache invalidation for folder-view tabs
  useCloseTabsOnEntityDelete() // A deleted canvas takes its tabs with it, in every group
  const toggleSearch = useCallback(() => setSearchOpen((prev) => !prev), [])
  const openShortcutsDialog = useCallback(() => setShowShortcutsDialog(true), [])
  const toggleShortcutsDialog = useCallback(() => setShowShortcutsDialog((prev) => !prev), [])
  const shortcutsHelpBinding = useShortcutBinding('view.shortcuts')
  useSearchShortcut(toggleSearch)
  useHintActivation()
  useMenuCommands({
    onNewNote: () => void handleNewNote(),
    onOpenSearch: () => setSearchOpen(true)
  })

  useEffect(() => {
    const openSearch = () => setSearchOpen(true)
    window.addEventListener('memry:open-search', openSearch)
    return () => window.removeEventListener('memry:open-search', openSearch)
  }, [])

  useEffect(() => {
    window.addEventListener('memry:open-shortcuts', openShortcutsDialog)
    return () => window.removeEventListener('memry:open-shortcuts', openShortcutsDialog)
  }, [openShortcutsDialog])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const isQuestionShortcut =
        event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey
      const isBoundShortcut = matchesShortcut(
        event,
        shortcutsHelpBinding.key,
        shortcutsHelpBinding.modifiers
      )

      if (!isQuestionShortcut && !isBoundShortcut) return
      if (isQuestionShortcut && isInputFocused()) return

      event.preventDefault()
      event.stopPropagation()
      toggleShortcutsDialog()
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [shortcutsHelpBinding, toggleShortcutsDialog])

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
    const openTestFolder = (event: CustomEvent<{ path?: string; title?: string }>) => {
      const { path, title } = event.detail ?? {}
      if (!path) return

      openTab({
        type: 'folder',
        title: title ?? path.split('/').pop() ?? 'Folder',
        icon: 'folder',
        path: `/folder/${encodeURIComponent(path)}`,
        entityId: path,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    }

    window.addEventListener('memry:test-open-folder', openTestFolder as EventListener)
    return () =>
      window.removeEventListener('memry:test-open-folder', openTestFolder as EventListener)
  }, [openTab])

  useEffect(() => {
    return window.api.onSettingsOpenRequested((section) => {
      openSettings(section)
    })
  }, [openSettings])

  useEffect(() => {
    return window.api.onInboxOpenItem((itemId) => {
      openTab({
        type: 'inbox',
        title: 'Inbox',
        icon: 'inbox',
        path: '/inbox',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false,
        viewState: { focusInboxItemId: itemId, focusedAt: Date.now() }
      })
    })
  }, [openTab])

  return (
    <TabDragProvider>
      <AgentTabTitleSync />
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

  // Update state - show a dedicated "Installing update…" screen while quitting to
  // install, so vault teardown never surfaces as a broken picker / frozen window.
  // Read only the two fields this screen needs: subscribing to the whole updater
  // state re-rendered the entire app tree on every download-progress tick.
  const isInstallingUpdate = useAppUpdaterSelector((state) => state.status === 'installing')
  const installingVersion = useAppUpdaterSelector((state) => state.availableVersion)

  // Vault state - check if vault is open
  const { status: vaultStatus, isLoading: vaultLoading } = useVault()
  const isVaultOpen = vaultStatus?.isOpen ?? false
  const vaultPath = vaultStatus?.path ?? null
  const queryClient = useQueryClient()

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

  // Calculate view counts and project task counts in a single pass over the
  // tasks. Both recompute on every task mutation, so re-filtering the whole list
  // once per view and once per project is the wrong shape at this level.
  const { viewCounts, projectTaskCounts } = useMemo(
    () => getTaskWorkspaceCounts(tasks, projects, taskViewIds),
    [tasks, projects]
  )

  // Update project task counts
  const projectsWithCounts = useMemo(() => {
    return projects.map((project) => ({
      ...project,
      taskCount: projectTaskCounts[project.id] ?? 0
    }))
  }, [projects, projectTaskCounts])

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
    onUpdateTask: (...args) => void handleUpdateTask(...args),
    onDeleteTask: (...args) => void handleDeleteTask(...args),
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
    <IncidentReportProvider>
      <TabErrorBoundary
        onError={(error, errorInfo) => log.error('Critical error:', error, errorInfo)}
      >
        <TasksProvider
          tasks={tasks}
          projects={projectsWithCounts}
          getOrderedTasks={taskOrder.getOrderedTasks}
        >
          <DayPanelProvider defaultOpen={true}>
            <CalendarViewProvider>
              <AISettingsProvider>
                <AIInlineProvider>
                  <HintModeProvider>
                    <TabProvider>
                      <AgentFeatureProvider>
                        <TabPersistenceManager>
                          <SettingsModalProvider>
                            <SelectedFolderProvider>
                              <SidebarDrillDownProvider>
                                <AppSidebar currentPage={currentPage} viewCounts={viewCounts} />
                                <SidebarInset className="flex flex-col overflow-hidden">
                                  <AppContent />
                                </SidebarInset>
                                {/* Opens the ephemeral read-only release-notes tab as part
                                    of the update flow. Lives inside TabProvider for openTab(). */}
                                <UpdateReleaseNotesTabOpener />
                                {/* Dev-only: window.openReleaseNotesDemo() to preview the tab
                                    with dummy data (updater never fires in dev). */}
                                {import.meta.env.DEV && <ReleaseNotesDevTrigger />}
                              </SidebarDrillDownProvider>
                              <TaskDragOverlay projects={projectsWithCounts} />
                              {/* Last child so paint order puts the chrome overlay above the
                                  tab-bar's drag-region (OS-level -webkit-app-region hit test picks
                                  the topmost layer; a drag-region painted over no-drag children eats
                                  clicks). Lives inside TabProvider for useTabs() back/forward nav. */}
                              <WindowControls className="pointer-events-auto fixed top-0 start-0 z-[60] w-[var(--chrome-width)]" />
                            </SelectedFolderProvider>
                          </SettingsModalProvider>
                        </TabPersistenceManager>
                      </AgentFeatureProvider>
                    </TabProvider>
                  </HintModeProvider>
                </AIInlineProvider>
              </AISettingsProvider>
            </CalendarViewProvider>
          </DayPanelProvider>
        </TasksProvider>
      </TabErrorBoundary>
    </IncidentReportProvider>
  )

  // Highest priority: once the user triggered install, keep this screen up
  // through the whole quit/relaunch regardless of vault state.
  if (isInstallingUpdate) {
    return <UpdatingScreen version={installingVersion} />
  }

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
        {/* First-run onboarding used to render with NO boundary: a render crash
            white-screened the app at the most churn-sensitive moment, reported
            only as a stackless generic window_error. */}
        <IncidentReportProvider>
          <TabErrorBoundary
            onError={(error, errorInfo) =>
              trackRendererError(
                'onboarding_error_boundary',
                error,
                errorInfo.componentStack ?? undefined
              )
            }
          >
            <VaultOnboarding />
          </TabErrorBoundary>
        </IncidentReportProvider>
        <UpdatePromptDialog />
        <UpdateInstallFailedDialog />
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
        <UpdatePromptDialog />
        <UpdateInstallFailedDialog />
        {/* Vault-open branch only: the tour that arms this never runs without a vault. */}
        <GithubStarCard />
        <Toaster />
      </ThemeSyncManager>
    </ThemeProvider>
  )
}

export default App
