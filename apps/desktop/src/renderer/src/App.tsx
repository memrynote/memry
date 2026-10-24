import {
  Activity,
  lazy,
  Suspense,
  useState,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef
} from 'react'
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
import { ThemeSyncManager, TabPersistenceManager } from '@/components/app-managers'
import { Loader2 } from '@/lib/icons'
import { AppSidebar } from '@/components/app-sidebar'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { APP_RAIL_WIDTH_PX } from '@/components/sidebar/app-rail'
import { WorkspaceDragStrip } from '@/components/sidebar/workspace-drag-strip'
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
import { useTitleBarSymbolColorSync } from '@/lib/window-controls-overlay'

// Tab System imports
import { TabProvider, useActiveTab, useTabs, type TabType } from '@/contexts/tabs'
import { TabsCommandBridge } from '@/contexts/tabs/tabs-command-bridge'
import {
  AppCommandOwners,
  WorkspaceCommandOwners,
  useAppCommands,
  useCommandDispatcher,
  type CommandImpl
} from '@/commands'
import { useRecordRecentlyOpened } from '@/hooks/use-recently-opened'
import { TasksProvider } from '@/contexts/tasks'
import { TabDragProvider, TabErrorBoundary } from '@/components/tabs'
import { SplitViewContainer } from '@/components/split-view'
import { ChordIndicator } from '@/components/keyboard'
import {
  useChordShortcuts,
  useMouseNavButtons,
  useDragHandlers,
  useTaskOrder,
  useVault,
  useUndoKeyboardShortcut,
  useReminderNotifications,
  useInboxReviewNotifications,
  useHintActivation
} from '@/hooks'
import { useAppZoom } from '@/hooks/use-app-zoom'
import { useReadwiseErrorToast } from '@/hooks/use-readwise-error-toast'
import { useCreateNewNote } from '@/hooks/use-create-new-note'
import { HintModeProvider } from '@/contexts/hint-mode'
import { HintOverlay, HintIndicator } from '@/components/hint-overlay'
import { SettingsModalProvider, useSettingsModal } from '@/contexts/settings-modal-context'
import { useFolderNoteShortcutsRuntime } from '@/hooks/use-folder-note-shortcuts'
import { onOpenSettingsRequested } from '@/lib/settings-navigation'
import { useFolderViewEvents } from '@/hooks/use-folder-view-events'
import { useCalendarChangeEvents } from '@/hooks/use-calendar-change-events'
import { useJournalChangeEvents } from '@/hooks/use-journal-change-events'
import { useIndexRecoveryNotice } from '@/hooks/use-index-recovery-notice'
import { useVaultLockRestoreNotice } from '@/hooks/use-vault-lock-restore-notice'
import { useCloseTabsOnEntityDelete } from '@/hooks/use-close-tabs-on-entity-delete'
import { useFlushOnQuit } from '@/hooks/use-flush-on-quit'
import { useStickyOpenTarget } from '@/hooks/use-sticky-open-target'
import { tasksService, queueTaskReorder } from '@/services/tasks-service'
import { IncidentReportProvider } from '@/components/diagnostics/incident-report-provider'
import { VaultSwitchingScreen } from '@/components/vault-switching-screen'
import { useFirstRunWizardActive } from '@/components/onboarding-wizard/first-run-store'
import { VaultSwitchContentCover } from '@/components/vault-switch-content-cover'
import {
  getVaultSwitchState,
  subscribeVaultSwitchState,
  useVaultSwitchState
} from '@/lib/vault-switch-state'
import { UpdatingScreen } from '@/components/updating-screen'
import { UpdateInstallFailedDialog } from '@/components/updater/update-install-failed-dialog'
import { ReleaseNotesDevTrigger } from '@/components/updater/release-notes-dev-trigger'
import { useAppUpdaterSelector } from '@/hooks/use-app-updater'
import { trackTelemetry } from '@/lib/telemetry'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import type { TelemetrySurface } from '@memry/contracts/telemetry-api'
import { createLogger } from '@/lib/logger'
import { getStartupTheme, THEME_STORAGE_KEY } from '@/lib/startup-theme'
import { useTaskWorkspaceData, useTaskWorkspaceMutations } from '@/features/tasks/use-task-queries'
import { useTaskUiStore } from '@/features/tasks/use-task-ui-store'
import { getTaskWorkspaceCounts } from '@/lib/task-utils'
import { useAgentMcpCurrentNoteResponder } from '@/agent-mcp/current-note-handler'
import { useAgentMcpInsertAtCursorResponder } from '@/agent-mcp/insert-at-cursor-handler'
import { useAgentMcpDesktopApiResponder } from '@/agent-mcp/desktop-api-handler'
import { useAgentMcpCanvasWriteResponder } from '@/agent-mcp/canvas-write-handler'
import { AgentFeatureProvider } from '@/agent-chat/agent-feature-provider'
import { AgentTabTitleSync } from '@/agent-chat/agent-tab-title-sync'
import { CanvasTabTitleSync } from '@/components/tabs/canvas-tab-title-sync'
import { HomeTabTitleSync } from '@/components/tabs/home-tab-title-sync'

const log = createLogger('App')
const startupTheme = getStartupTheme()

// Shell surfaces that are closed on first paint load through import() so their
// dependency trees stay out of the entry chunk. The settings pages behind
// SettingsView and first-run onboarding are the large ones.
const loadCommandPalette = () => import('@/components/search/command-palette')
const LazyCommandPalette = lazy(async () => ({
  default: (await loadCommandPalette()).CommandPalette
}))
const loadCommandsPalette = () => import('@/components/commands/commands-palette')
const LazyCommandsPalette = lazy(async () => ({
  default: (await loadCommandsPalette()).CommandsPalette
}))
const LazyKeyboardShortcutsDialog = lazy(async () => ({
  default: (await import('@/components/keyboard/keyboard-shortcuts-dialog')).KeyboardShortcutsDialog
}))
const LazySettingsView = lazy(async () => ({
  default: (await import('@/components/settings-view')).SettingsView
}))
const LazyVaultOnboarding = lazy(async () => ({
  default: (await import('@/components/onboarding-wizard/first-run-gate')).FirstRunGate
}))

/** Upper bound on waiting for an idle slot before the palettes mount anyway. */
const COMMAND_PALETTE_IDLE_TIMEOUT_MS = 2000

/** At most one palette is open: ⌘K searches, ⌘P runs commands. */
type ActivePalette = 'search' | 'commands'

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

/**
 * A key toggles, so the chord that opened a surface closes it. A menu item or
 * button only opens: it asks to see the surface, and asking twice is harmless.
 */
const keyToggles = (toggle: () => void, open: () => void): CommandImpl => ({
  run: ({ source }) => (source === 'keyboard' ? toggle() : open())
})

const AppContent = (): React.JSX.Element => {
  const { openTab } = useTabs()
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false)
  const [activePalette, setActivePalette] = useState<ActivePalette | null>(null)

  // The palettes mount closed once the window is idle, so the first ⌘K or ⌘P
  // opens an already loaded and initialized palette. Opening one earlier mounts
  // it then. They stay mounted afterwards, as they did when they were eager.
  const [commandPaletteMounted, setCommandPaletteMounted] = useState(false)
  if (activePalette === 'search' && !commandPaletteMounted) setCommandPaletteMounted(true)
  const [commandsPaletteMounted, setCommandsPaletteMounted] = useState(false)
  if (activePalette === 'commands' && !commandsPaletteMounted) setCommandsPaletteMounted(true)
  const [shortcutsDialogMounted, setShortcutsDialogMounted] = useState(false)
  if (showShortcutsDialog && !shortcutsDialogMounted) setShortcutsDialogMounted(true)

  useEffect(() => {
    const mountPalette = (): void => {
      loadCommandPalette().then(
        () => setCommandPaletteMounted(true),
        (error: unknown) => log.warn('Command palette preload failed', error)
      )
      loadCommandsPalette().then(
        () => setCommandsPaletteMounted(true),
        (error: unknown) => log.warn('Commands palette preload failed', error)
      )
    }
    // jsdom has no requestIdleCallback; Chromium always does.
    if (typeof window.requestIdleCallback !== 'function') {
      const timer = setTimeout(mountPalette, 0)
      return () => clearTimeout(timer)
    }
    const handle = window.requestIdleCallback(mountPalette, {
      timeout: COMMAND_PALETTE_IDLE_TIMEOUT_MS
    })
    return () => window.cancelIdleCallback(handle)
  }, [])

  // Fire `page_viewed` whenever the active tab type changes. Only ever surface enums,
  // never tab titles, file paths, or note IDs.
  const activeTab = useActiveTab()
  const { enabled: aiEnabled } = useAISettingsContext()
  useAgentMcpCurrentNoteResponder({ enabled: aiEnabled })
  useAgentMcpInsertAtCursorResponder({ enabled: aiEnabled })
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

  // Keyboard shortcuts
  useMouseNavButtons()
  const isChordActive = useChordShortcuts()
  const { open: openSettings, isOpen: isSettingsOpen } = useSettingsModal()
  const openReadwiseSettings = useCallback(() => openSettings('import:readwise'), [openSettings])
  useAppZoom()
  useFolderNoteShortcutsRuntime()
  useUndoKeyboardShortcut() // T051-T054: Cmd+Z for task undo
  useReadwiseErrorToast(openReadwiseSettings) // One toast when Readwise needs the user (D19)
  useReminderNotifications() // T231-T233: In-app toast notifications for reminders
  useInboxReviewNotifications() // Daily inbox review nudge: toast + open-inbox on click
  useIndexRecoveryNotice() // Says so when Memry repaired its own search index
  useVaultLockRestoreNotice() // Says so when a locked note's outside edit was undone
  useFolderViewEvents() // Global cache invalidation for folder-view tabs
  useCalendarChangeEvents() // Global cache invalidation for calendar ranges in background tabs
  useJournalChangeEvents() // Global cache invalidation for journal entries/heatmaps in background tabs
  useCloseTabsOnEntityDelete() // A deleted canvas takes its tabs with it, in every group
  useStickyOpenTarget() // The sticky's Open shows what a send created
  const togglePalette = useCallback((palette: ActivePalette) => {
    if (isVaultSwitchPending()) return
    setActivePalette((prev) => (prev === palette ? null : palette))
  }, [])
  const openPalette = useCallback((palette: ActivePalette) => {
    if (isVaultSwitchPending()) return
    setActivePalette(palette)
  }, [])
  const closePalette = useCallback(() => setActivePalette(null), [])
  const openShortcutsDialog = useCallback(() => setShowShortcutsDialog(true), [])
  const toggleShortcutsDialog = useCallback(() => setShowShortcutsDialog((prev) => !prev), [])
  const createNewNote = useCreateNewNote()
  useHintActivation()

  useAppCommands('shell', {
    'nav.newNote': { run: () => createNewNote() },
    'nav.search': keyToggles(
      () => togglePalette('search'),
      () => openPalette('search')
    ),
    'nav.commands': keyToggles(
      () => togglePalette('commands'),
      () => openPalette('commands')
    ),
    'view.shortcuts': keyToggles(toggleShortcutsDialog, openShortcutsDialog)
  })

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

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- window events have no map entry for this custom event name; only CustomEvent is ever dispatched
    window.addEventListener('memry:test-open-note', openTestNote as EventListener)
    return () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- window events have no map entry for this custom event name; only CustomEvent is ever dispatched
      window.removeEventListener('memry:test-open-note', openTestNote as EventListener)
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

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- window events have no map entry for this custom event name; only CustomEvent is ever dispatched
    window.addEventListener('memry:test-open-folder', openTestFolder as EventListener)
    return () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- window events have no map entry for this custom event name; only CustomEvent is ever dispatched
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
      <TabsCommandBridge />
      <AppCommandOwners />
      <WorkspaceCommandOwners />
      <AgentTabTitleSync />
      <CanvasTabTitleSync />
      <HomeTabTitleSync />
      {/* No background: the workspace card's ::before draws the surface below the title
          row (main.css); a fill here would cover the title row and the rounded corner.
          Settings takes the workspace while open. The panes stay mounted (hidden) so
          editors, scroll positions and unsaved state are untouched on the way back. */}
      <div className={isSettingsOpen ? 'hidden' : 'flex flex-1 overflow-hidden'} id="main-content">
        <SplitViewContainer />
      </div>
      {isSettingsOpen ? (
        <Suspense fallback={null}>
          <LazySettingsView />
        </Suspense>
      ) : (
        <GlobalDayPanel />
      )}

      {/* Chord Indicator */}
      <ChordIndicator isActive={isChordActive} />

      {/* Hint Mode Overlay + Indicator */}
      <HintOverlay />
      <HintIndicator />

      {/* Keyboard Shortcuts Dialog */}
      {shortcutsDialogMounted && (
        <Suspense fallback={null}>
          <LazyKeyboardShortcutsDialog
            isOpen={showShortcutsDialog}
            onClose={() => setShowShortcutsDialog(false)}
          />
        </Suspense>
      )}

      {/* Global Search Command Palette */}
      {commandPaletteMounted && (
        <Suspense fallback={null}>
          <LazyCommandPalette
            open={activePalette === 'search'}
            onOpenChange={(open) => (open ? openPalette('search') : closePalette())}
          />
        </Suspense>
      )}

      {/* Commands Palette */}
      {commandsPaletteMounted && (
        <Suspense fallback={null}>
          <LazyCommandsPalette
            open={activePalette === 'commands'}
            onOpenChange={(open) => (open ? openPalette('commands') : closePalette())}
          />
        </Suspense>
      )}
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
                                {/* Sidebar and workspace read as one surface below the h-9
                                    title row; the workspace's top-row tab bars sit in that
                                    row (main.css, data-workspace-card). */}
                                <SidebarInset
                                  data-workspace-card=""
                                  className="flex min-w-0 flex-col overflow-hidden"
                                >
                                  <AppContent />
                                  <VaultSwitchContentCover />
                                </SidebarInset>
                                <WorkspaceDragStrip />
                                {/* Dev-only: window.openReleaseNotesDemo() to preview the tab
                                    with dummy data (updater never fires in dev). */}
                                {import.meta.env.DEV && <ReleaseNotesDevTrigger />}
                              </SidebarDrillDownProvider>
                              <TaskDragOverlay projects={projectsWithCounts} />
                              {/* Last child so paint order puts the chrome overlay above the
                                  tab-bar's drag-region (OS-level -webkit-app-region hit test picks
                                  the topmost layer; a drag-region painted over no-drag children eats
                                  clicks). Lives inside TabProvider for useTabs() back/forward nav. */}
                              <WindowControls className="pointer-events-auto z-[60]" />
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
      <SidebarProvider
        className="bg-sidebar-rail"
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- CSS custom properties are not in CSSProperties
        style={{ '--sidebar-offset': `${APP_RAIL_WIDTH_PX}px` } as React.CSSProperties}
      >
        <DragProvider
          tasks={tasks}
          selectedIds={selectedTaskIds}
          selectedIdsRef={selectedTaskIdsRef}
          onDragEnd={(event, state) => handleDragEnd(event, state)}
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

/**
 * Vault workspaces kept mounted, the open one included. Two keeps the previous
 * vault warm for switching back and forth; every extra one holds a full hidden
 * workspace (DOM, tabs, query cache) in memory.
 */
const MAX_KEPT_VAULTS = 2

/**
 * Main opens one vault at a time, but the renderer does not have to forget the
 * others. Each visited vault keeps its workspace mounted inside a hidden
 * <Activity>, with its own QueryClient (query keys are not vault-scoped, so one
 * cache cannot hold two vaults). Hidden, a workspace runs no effects: no IPC,
 * no listeners, no shortcuts. Switching back shows the same DOM, tabs, scroll
 * and cached rows at once, while its queries refetch in the background.
 *
 * Menus and dialogs portal to <body>, outside the hidden tree. React 19.3 and
 * later hide portal contents with their Activity. Before 19.3, a vault menu
 * still closing when the switch landed stayed on screen, invisible, and its
 * rows switched vaults on click (#2504).
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
      // result that lands then answers for another vault and must not be
      // served as this vault's rows. Manual writes (setQueryData) are not reads
      // from main and are left alone.
      created.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated') return
        const { action, query } = event
        const isFetch = action.type === 'fetch'
        if (!isFetch && (action.type !== 'success' || action.manual)) return
        const { pending: switchTarget } = getVaultSwitchState()
        const isOpenVault =
          path === activePathRef.current && (switchTarget === null || switchTarget.path === path)
        if (isOpenVault) return
        if (isFetch) {
          // Stop the read before it lands and keep the rows this vault already
          // has. Resetting after the fact emptied them, so coming back to a
          // kept vault showed skeletons until its refetch arrived. The query
          // stays invalidated (see the leave handler) and refetches on reveal.
          // The retryer is created right after this event: cancel a tick later.
          if (query.state.data !== undefined) {
            queueMicrotask(() => void query.cancel({ revert: true }))
          }
          return
        }
        // A read that got through (nothing cached to keep, or it outran the
        // cancel): drop it rather than serve another vault's rows.
        query.reset()
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reads the vault registry refs (clients/lifecycles) that are intentionally outside React state
    activePathRef.current = activePath
    for (const [path, lifecycle] of lifecyclesRef.current) {
      lifecycle.hidden = path !== activePath
    }
  }, [activePath, kept])

  // Evicted vaults drop their cache, and whatever their hidden tree parked.
  // Releases external resources held in refs; nothing flows to a parent.
  /* oxlint-disable react-you-might-not-need-an-effect/no-event-handler, react-you-might-not-need-an-effect/no-pass-data-to-parent */
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reads the vault registry refs (clients/lifecycles) that are intentionally outside React state
  }, [kept])
  /* oxlint-enable react-you-might-not-need-an-effect/no-event-handler, react-you-might-not-need-an-effect/no-pass-data-to-parent */

  useEffect(() => {
    const lifecycles = lifecyclesRef.current
    return () => {
      for (const lifecycle of lifecycles.values()) disposeVaultWorkspace(lifecycle)
      lifecycles.clear()
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reads the vault registry refs (clients/lifecycles) that are intentionally outside React state
  }, [])

  // Leaving a vault: stop its in-flight reads before main closes it, and mark
  // everything stale so the workspace refetches when it is shown again. If the
  // switch fails and this vault stays open, refetch what the cache fence
  // emptied meanwhile, or those views would sit on an empty loading state.
  useEffect(() => {
    let switchingAway = false
    return subscribeVaultSwitchState(() => {
      if (!activePath) return
      const client = clientsRef.current.get(activePath)
      if (!client) return
      const { pending: switchPending, arrival } = getVaultSwitchState()
      if (switchPending === null) {
        if (!switchingAway) return
        switchingAway = false
        // Only a failed switch leaves this vault open. After a successful one
        // main already serves the next vault, and `activePath` here is still
        // this one until React commits: a refetch now would ask the wrong vault.
        // Main is on the next vault now, but a held reveal (pager settling)
        // keeps `activePath` on this one for a while, and this workspace stays
        // visible with live effects. Without clearing the ref, the cache fence
        // would take reads main answers from the next vault as this vault's
        // rows (the tree then shows the other vault's notes). The layout effect
        // sets the ref again when the incoming vault commits.
        if (arrival !== null && arrival.path !== activePath) {
          activePathRef.current = null
          return
        }
        void client.refetchQueries({
          type: 'active',
          predicate: (query) =>
            query.state.status === 'pending' && query.state.fetchStatus === 'idle'
        })
        return
      }
      if (switchPending.path === activePath || switchingAway) return
      switchingAway = true
      void client.cancelQueries()
      void client.invalidateQueries({ refetchType: 'none' })
    })
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reads the vault registry refs (clients/lifecycles) that are intentionally outside React state
  }, [activePath])

  return (
    <>
      {/* oxlint-disable-next-line react/refs -- lazy per-path client/lifecycle registry; created once per vault path and stable afterwards */}
      {kept.map((path) => (
        <Activity key={path} mode={path === activePath ? 'visible' : 'hidden'}>
          <div className="contents" inert={leaving && path === activePath}>
            <QueryClientProvider client={clientFor(path)}>
              {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- lifecycleFor returns a registry-stable object per vault path */}
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
  useTitleBarSymbolColorSync()
  useCommandDispatcher()

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
  // The wizard writes its choices into the vault it opens, so it outlives the open.
  const firstRunActive = useFirstRunWizardActive()

  const prevVaultPathRef = useRef<string | null>(null)

  useEffect(() => {
    if (!vaultPath) return
    if (prevVaultPathRef.current && prevVaultPathRef.current !== vaultPath) {
      // Nothing to reset here: query caches are per vault (see VaultStack), and
      // tab state and expanded folders (`sidebarTreeExpandedKey`) are stored per
      // vault and read back on the way in.
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
  if (!isVaultOpen && pendingVaultSwitch && !firstRunActive) {
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

  if (!isVaultOpen || firstRunActive) {
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
            <Suspense fallback={null}>
              <LazyVaultOnboarding />
            </Suspense>
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
