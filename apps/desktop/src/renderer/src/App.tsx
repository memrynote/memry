import { useState, useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from '@/lib/icons'
import { AppSidebar } from '@/components/app-sidebar'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { AIInlineProvider } from '@/contexts/ai-inline-context'
import { DayPanelProvider } from '@/contexts/day-panel-context'
import { SidebarDrillDownProvider } from '@/contexts/sidebar-drill-down'
import { SelectedFolderProvider } from '@/contexts/selected-folder-context'
import { GlobalDayPanel } from '@/components/day-panel'
import { TaskDragOverlay } from '@/components/tasks/drag-drop'
import { ThemeProvider } from 'next-themes'

// Tab System imports
import { TabProvider, useTabs } from '@/contexts/tabs'
import { useTabPersistence, useSessionRestore, STORAGE_KEY } from '@/contexts/tabs/persistence'
import { TabDragProvider, TabErrorBoundary } from '@/components/tabs'
import { SplitViewContainer } from '@/components/split-view'
import { ChordIndicator, KeyboardShortcutsDialog } from '@/components/keyboard'
import {
  useTabKeyboardShortcuts,
  useChordShortcuts,
  useVault,
  useSettingsShortcut,
  useNewNoteShortcut,
  useUndoKeyboardShortcut,
  useReminderNotifications,
  useSearchShortcut
} from '@/hooks'
import { CommandPalette } from '@/components/search/command-palette'
import { SettingsModalProvider, useSettingsModal } from '@/contexts/settings-modal-context'
import { SettingsModal } from '@/components/settings-modal'
import { useFolderViewEvents } from '@/hooks/use-folder-view-events'
import { useFlushOnQuit } from '@/hooks/use-flush-on-quit'
import { notesService } from '@/services/notes-service'
import { VaultOnboarding } from '@/components/vault-onboarding'
import { FirstRunOnboarding } from '@/components/first-run-onboarding'
import { useThemeSync } from '@/hooks/use-theme-sync'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { createLogger } from '@/lib/logger'
import { getStartupTheme, THEME_STORAGE_KEY } from '@/lib/startup-theme'
import { TasksAppBoundary } from '@/features/tasks/tasks-app-boundary'

const log = createLogger('App')
const startupTheme = getStartupTheme()

// Base pages (non-task)
export type BasePage = 'inbox' | 'journal' | 'graph'

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

  useEffect(() => {
    const openSearch = () => setSearchOpen(true)
    window.addEventListener('memry:open-search', openSearch)
    return () => window.removeEventListener('memry:open-search', openSearch)
  }, [])

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

  // Main content with TabProvider and TasksProvider wrapping everything
  // Wrapped in TabErrorBoundary for graceful error handling
  const mainContent = (
    <TasksAppBoundary>
      {({ projects, viewCounts }) => (
        <TabErrorBoundary
          onError={(error, errorInfo) => log.error('Critical error:', error, errorInfo)}
        >
          <DayPanelProvider>
            <AIInlineProvider>
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
                      <TaskDragOverlay projects={projects} />
                    </SelectedFolderProvider>
                  </SettingsModalProvider>
                </TabPersistenceManager>
              </TabProvider>
            </AIInlineProvider>
          </DayPanelProvider>
        </TabErrorBoundary>
      )}
    </TasksAppBoundary>
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
          {mainContent}
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
