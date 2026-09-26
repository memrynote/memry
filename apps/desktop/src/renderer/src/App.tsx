import { Activity, useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useToday } from '@/hooks/use-today'
import { resolveProjectReorderTarget } from '@/components/sidebar/sidebar-drag-types'
import type { DragEndEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { APP_QUERY_DEFAULT_OPTIONS } from '@/lib/query-client-options'
import { VaultScopeProvider } from '@/contexts/vault-scope'
import {
  VaultWorkspaceLifecycleContext,
  createVaultWorkspaceLifecycle,
  disposeVaultWorkspace,
  type VaultWorkspaceLifecycle
} from '@/lib/vault-workspace-lifecycle'
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
import { useRecordRecentlyOpened } from '@/hooks/use-recently-opened'
import { useTabSessionPersistence } from '@/contexts/tabs/persistence'
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
  useSwitchVaultShortcut,
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
import { requestVaultSwitcherOpen } from '@/lib/vault-switcher-open'
import { HintModeProvider } from '@/contexts/hint-mode'
import { HintOverlay, HintIndicator } from '@/components/hint-overlay'
import { CommandPalette } from '@/components/search/command-palette'
import { SettingsModalProvider, useSettingsModal } from '@/contexts/settings-modal-context'
import { onOpenSettingsRequested } from '@/lib/settings-navigation'
import { SettingsModal } from '@/components/settings-modal'
import { useFolderViewEvents } from '@/hooks/use-folder-view-events'
import { useCalendarChangeEvents } from '@/hooks/use-calendar-change-events'
import { useJournalChangeEvents } from '@/hooks/use-journal-change-events'
import { useIndexRecoveryNotice } from '@/hooks/use-index-recovery-notice'
import { useCloseTabsOnEntityDelete } from '@/hooks/use-close-tabs-on-entity-delete'
import { useFlushOnQuit } from '@/hooks/use-flush-on-quit'
import { useMenuCommands } from '@/hooks/use-menu-commands'
import { tasksService, queueTaskReorder } from '@/services/tasks-service'
import { notesService } from '@/services/notes-service'
import { IncidentReportProvider } from '@/components/diagnostics/incident-report-provider'
import { VaultOnboarding } from '@/components/vault-onboarding'
import { VaultSwitchingScreen } from '@/components/vault-switching-screen'
import { VaultSwitchContentCover } from '@/components/vault-switch-content-cover'
import {
  getVaultSwitchState,
  subscribeVaultSwitchState,
  useVaultSwitchState,
  wasEnteredBySwitch
} from '@/lib/vault-switch-state'
import { UpdatingScreen } from '@/components/updating-screen'
import { UpdateInstallFailedDialog } from '@/components/updater/update-install-failed-dialog'
import { ReleaseNotesDevTrigger } from '@/components/updater/release-notes-dev-trigger'
import { UpdateReleaseNotesTabOpener } from '@/components/updater/update-release-notes-tab-opener'
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
import { CanvasTabTitleSync } from '@/components/tabs/canvas-tab-title-sync'
import { HomeTabTitleSync } from '@/components/tabs/home-tab-title-sync'

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
function TabPersistenceManager({
  vaultPath,
  children
}: {
  vaultPath: string | null
  children: React.ReactNode
}): React.JSX.Element {
  // Restore the stored session on mount, and hold the debounced auto-save until
  // that restore has landed — otherwise the save writes the provider's default
  // Home tab over the session the restore is still on its way to read.
  //
  // The vault path decides which session that is: each vault keeps its own tabs,
  // so switching reads the other vault's set instead of destroying either.
  //
  // "Restore session on start" is about launching the app. A vault entered by
  // an in-app switch always comes back as it was left, tabs and all; read once
  // at mount, since this tree lives exactly as long as the vault is open.
  const [enteredBySwitch] = useState(() => wasEnteredBySwitch(vaultPath))
  useTabSessionPersistence({ vaultPath, restoreFullSession: enteredBySwitch })

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

/**
 * During a vault switch the leaving workspace is still on screen, inert, while
 * main is already opening the next vault. `inert` does not stop window
 * listeners or menu IPC, so a ⌘N there would create a note in the half-open
 * next vault and open its tab in the leaving one. Window-level create and
 * navigation commands stand down until the switch settles.
 */
function isVaultSwitchPending(): boolean {
  return getVaultSwitchState().pending !== null
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
  useRecordRecentlyOpened()
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
    if (isVaultSwitchPending()) return
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
        // `rename` opens the row's name input there, so the ⌘N note does not
        // have to be renamed off `Untitled` as a separate step (#2272).
        revealNoteInSidebar(result.note.id, { rename: true })
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
  useSwitchVaultShortcut(requestVaultSwitcherOpen)
  useNewNoteShortcut(() => void handleNewNote())
  useUndoKeyboardShortcut() // T051-T054: Cmd+Z for task undo
  useReminderNotifications() // T231-T233: In-app toast notifications for reminders
  useInboxReviewNotifications() // Daily inbox review nudge: toast + open-inbox on click
  useIndexRecoveryNotice() // Says so when Memry repaired its own search index
  useFolderViewEvents() // Global cache invalidation for folder-view tabs
  useCalendarChangeEvents() // Global cache invalidation for calendar ranges in background tabs
  useJournalChangeEvents() // Global cache invalidation for journal entries/heatmaps in background tabs
  useCloseTabsOnEntityDelete() // A deleted canvas takes its tabs with it, in every group
  const toggleSearch = useCallback(() => {
    if (isVaultSwitchPending()) return
    setSearchOpen((prev) => !prev)
  }, [])
  const openSearch = useCallback(() => {
    if (isVaultSwitchPending()) return
    setSearchOpen(true)
  }, [])
  const openShortcutsDialog = useCallback(() => setShowShortcutsDialog(true), [])
  const toggleShortcutsDialog = useCallback(() => setShowShortcutsDialog((prev) => !prev), [])
  const shortcutsHelpBinding = useShortcutBinding('view.shortcuts')
  useSearchShortcut(toggleSearch)
  useHintActivation()
  useMenuCommands({
    onNewNote: () => void handleNewNote(),
    onOpenSearch: openSearch
  })

  useEffect(() => {
    window.addEventListener('memry:open-search', openSearch)
    return () => window.removeEventListener('memry:open-search', openSearch)
  }, [openSearch])

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

  useEffect(() => onOpenSettingsRequested(openSettings), [openSettings])

  useEffect(() => {
    return window.api.onInboxOpenItem((itemId) => {
      if (isVaultSwitchPending()) return
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
      <CanvasTabTitleSync />
      <HomeTabTitleSync />
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
// VAULT WORKSPACE
// =============================================================================

/**
 * Everything that belongs to one open vault: its task data, tabs, sidebar and
 * content. Rendered by VaultStack, which keeps recently visited vaults mounted
 * (hidden) so switching back is a visibility change, not a cold mount.
 */
function VaultWorkspace({ vaultPath }: { vaultPath: string }): React.JSX.Element {
  // Navigation state
  // Note: navigation is now handled by tabs
  // currentPage is still used for sidebar highlight state
  const [currentPage] = useState<AppPage>('inbox')

  const { tasks, projects } = useTaskWorkspaceData({ enabled: true })
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
  const todayKey = useToday()
  const { viewCounts, projectTaskCounts } = useMemo(
    () => getTaskWorkspaceCounts(tasks, projects, taskViewIds, new Date(`${todayKey}T00:00:00`)),
    [tasks, projects, todayKey]
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

      // Handle project reordering in sidebar (not handled by useDragHandlers).
      // Keyed on the explicit drag type: the old `type === undefined` test also
      // matched every other untyped sortable in the shared DndContext.
      const projectReorder = resolveProjectReorderTarget({
        activeType: activeData?.type,
        activeId: String(active.id),
        overId: String(over.id),
        projectIds: projects.map((p) => p.id)
      })
      if (projectReorder) {
        setProjects((prev) => {
          const reorderedProjects = arrayMove(prev, projectReorder.from, projectReorder.to)
          void tasksService.reorderProjects(
            reorderedProjects.map((project) => project.id),
            reorderedProjects.map((_, index) => index)
          )
          return reorderedProjects
        })
        return
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
                        <TabPersistenceManager vaultPath={vaultPath}>
                          <SettingsModalProvider>
                            <SelectedFolderProvider>
                              <SidebarDrillDownProvider>
                                <AppSidebar currentPage={currentPage} viewCounts={viewCounts} />
                                <SidebarInset className="flex flex-col overflow-hidden">
                                  <AppContent />
                                  <VaultSwitchContentCover />
                                </SidebarInset>
                                {/* Opens the ephemeral read-only release-notes tab after an
                                    update+restart. Lives inside TabProvider for openTab(). */}
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

  return (
    <ThemeSyncManager>
      <SidebarProvider>
        <DragProvider
          tasks={tasks}
          selectedIds={selectedTaskIds}
          selectedIdsRef={selectedTaskIdsRef}
          onDragEnd={(event, state) => void handleDragEnd(event, state)}
        >
          <DroppedPriorityProvider value={droppedPriorities}>{mainContent}</DroppedPriorityProvider>
        </DragProvider>
      </SidebarProvider>
    </ThemeSyncManager>
  )
}

// =============================================================================
// VAULT STACK
// =============================================================================

/** Vault workspaces kept mounted, the open one included. */
const MAX_KEPT_VAULTS = 3

/**
 * Main opens one vault at a time, but the renderer does not have to forget the
 * others. Each visited vault keeps its workspace mounted inside a hidden
 * <Activity>, with its own QueryClient (query keys are not vault-scoped, so one
 * cache cannot hold two vaults). Hidden, a workspace runs no effects: no IPC,
 * no listeners, no shortcuts. Switching back shows the same DOM, tabs, scroll
 * and cached rows at once, while its queries refetch in the background.
 */
function VaultStack({ activePath }: { activePath: string | null }): React.JSX.Element {
  const clientsRef = useRef(new Map<string, QueryClient>())
  const { pending } = useVaultSwitchState()
  // While main swaps vaults the outgoing workspace stays on screen, but its
  // vault is closing: nothing in it may start work against it.
  const leaving = pending !== null && pending.path !== activePath
  const [kept, setKept] = useState<string[]>(() => (activePath ? [activePath] : []))

  // Most recent last; adjusted during render so the incoming vault mounts in
  // the same commit that reveals it.
  if (activePath && kept[kept.length - 1] !== activePath) {
    setKept([...kept.filter((path) => path !== activePath), activePath].slice(-MAX_KEPT_VAULTS))
  }

  // The vault main has open, as of the last commit. Read by the cache fence
  // below at event time, not during render.
  const activePathRef = useRef(activePath)

  const clientFor = (path: string): QueryClient => {
    let client = clientsRef.current.get(path)
    if (!client) {
      const created = new QueryClient({ defaultOptions: APP_QUERY_DEFAULT_OPTIONS })
      // Cache fence. Once a switch away from this vault starts, main may
      // already serve the next vault, and the leaving workspace's observers
      // can still fetch (retries, reconnect, event-driven invalidations). A
      // result that lands then answers for another vault: reset the query so
      // it cannot be served as this vault's fresh rows. Manual writes
      // (setQueryData) are not reads from main and are left alone.
      created.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'success') return
        if (event.action.manual) return
        const { pending } = getVaultSwitchState()
        const isOpenVault =
          path === activePathRef.current && (pending === null || pending.path === path)
        if (!isOpenVault) event.query.reset()
      })
      clientsRef.current.set(path, created)
      client = created
    }
    return client
  }

  const lifecyclesRef = useRef(new Map<string, VaultWorkspaceLifecycle>())
  const lifecycleFor = (path: string): VaultWorkspaceLifecycle => {
    let lifecycle = lifecyclesRef.current.get(path)
    if (!lifecycle) {
      lifecycle = createVaultWorkspaceLifecycle()
      lifecyclesRef.current.set(path, lifecycle)
    }
    return lifecycle
  }

  // Flag hidden workspaces in the layout phase: a hide runs the workspace's
  // effect cleanups after this, and those read the flag to tell a hide from an
  // unmount (see `vault-workspace-lifecycle`).
  useLayoutEffect(() => {
    activePathRef.current = activePath
    for (const [path, lifecycle] of lifecyclesRef.current) {
      lifecycle.hidden = path !== activePath
    }
  }, [activePath, kept])

  // Evicted vaults drop their cache, and whatever their hidden tree parked.
  useEffect(() => {
    for (const [path, client] of clientsRef.current) {
      if (kept.includes(path)) continue
      client.clear()
      clientsRef.current.delete(path)
    }
    for (const [path, lifecycle] of lifecyclesRef.current) {
      if (kept.includes(path)) continue
      disposeVaultWorkspace(lifecycle)
      lifecyclesRef.current.delete(path)
    }
  }, [kept])

  useEffect(() => {
    const lifecycles = lifecyclesRef.current
    return () => {
      for (const lifecycle of lifecycles.values()) disposeVaultWorkspace(lifecycle)
      lifecycles.clear()
    }
  }, [])

  // Leaving a vault: stop its in-flight reads before main closes it, and mark
  // everything stale so the workspace refetches when it is shown again. If the
  // switch fails and this vault stays open, refetch what the cache fence
  // emptied meanwhile, or those views would sit on an empty loading state.
  useEffect(() => {
    let leaving = false
    return subscribeVaultSwitchState(() => {
      if (!activePath) return
      const client = clientsRef.current.get(activePath)
      if (!client) return
      const { pending, arrival } = getVaultSwitchState()
      if (pending === null) {
        if (!leaving) return
        leaving = false
        // Only a failed switch leaves this vault open. After a successful one
        // main already serves the next vault, and `activePath` here is still
        // this one until React commits: a refetch now would ask the wrong vault.
        if (arrival !== null && arrival.path !== activePath) return
        void client.refetchQueries({
          type: 'active',
          predicate: (query) =>
            query.state.status === 'pending' && query.state.fetchStatus === 'idle'
        })
        return
      }
      if (pending.path === activePath || leaving) return
      leaving = true
      void client.cancelQueries()
      void client.invalidateQueries({ refetchType: 'none' })
    })
  }, [activePath])

  return (
    <>
      {kept.map((path) => (
        <Activity key={path} mode={path === activePath ? 'visible' : 'hidden'}>
          <div className="contents" inert={leaving && path === activePath}>
            <QueryClientProvider client={clientFor(path)}>
              <VaultWorkspaceLifecycleContext.Provider value={lifecycleFor(path)}>
                <VaultScopeProvider vaultPath={path}>
                  <VaultWorkspace vaultPath={path} />
                </VaultScopeProvider>
              </VaultWorkspaceLifecycleContext.Provider>
            </QueryClientProvider>
          </div>
        </Activity>
      ))}
    </>
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
  const { pending: pendingVaultSwitch } = useVaultSwitchState()

  const prevVaultPathRef = useRef<string | null>(null)

  useEffect(() => {
    if (!vaultPath) return
    if (prevVaultPathRef.current && prevVaultPathRef.current !== vaultPath) {
      // Expanded folder ids belong to the vault being left and mean nothing in
      // the one being entered. Query caches are per vault (see VaultStack), and
      // tab state is stored per vault and read back on the way in.
      localStorage.removeItem('sidebar-tree-expanded')
      log.info('Vault switched')
    }
    prevVaultPathRef.current = vaultPath
  }, [vaultPath])

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

  // Mid-switch the old vault is closed and the next is not open yet. That gap
  // is not "no vault": keep the shell instead of flashing onboarding.
  if (!isVaultOpen && pendingVaultSwitch) {
    return (
      <ThemeProvider
        attribute="class"
        defaultTheme={startupTheme}
        enableSystem
        themes={['light', 'dark', 'white', 'system']}
        storageKey={THEME_STORAGE_KEY}
      >
        <VaultSwitchingScreen target={pendingVaultSwitch} />
      </ThemeProvider>
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
      <VaultStack activePath={vaultPath} />
      <UpdateInstallFailedDialog />
      <Toaster />
    </ThemeProvider>
  )
}

export default App
