'use client'

import * as React from 'react'
import { useMemo, useState, useCallback, useRef } from 'react'
import { getI18n } from 'react-i18next'
import {
  Calendar2,
  CloudOff,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  FilePlus,
  FolderPlus,
  ChartRelationship,
  Home,
  Plus,
  Settings,
  Upload
} from '@/lib/icons'
import { SidebarInbox, SidebarJournal, SidebarTasks } from '@/lib/icons/sidebar-nav-icons'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { VaultSwitcher } from '@/components/vault-switcher'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail
} from '@/components/ui/sidebar'
import { SidebarNav } from '@/components/sidebar/sidebar-nav'
import { SidebarSection } from '@/components/sidebar-section'
import { NotesTree, type NotesTreeActions } from '@/components/notes-tree'
import { SidebarTagList } from '@/components/sidebar/sidebar-tag-list'
import { SidebarUpdateButton } from '@/components/sidebar/sidebar-update-button'
import { SidebarFeedbackButton } from '@/components/sidebar/sidebar-feedback-button'
import { SidebarBookmarkList } from '@/components/sidebar/sidebar-bookmark-list'
import { CanvasTree, type CanvasTreeActions } from '@/components/sidebar/canvas-tree/canvas-tree'
import { SortableProjectList } from '@/components/sidebar/sortable-project-list'
import { ProjectModal } from '@/components/tasks/project-modal'
import { SidebarDrillDownContainer } from '@/components/sidebar/sidebar-drill-down-container'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Picker } from '@/components/ui/picker'
import { NewItemMenuItems } from '@/components/tabs/new-item-menu-items'
import { useSelectedFolder } from '@/contexts/selected-folder-context'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import type { OpenSidebarItemOptions } from '@/hooks/use-sidebar-navigation'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { useKeyboardShortcuts, type KeyboardShortcut } from '@/hooks/use-keyboard-shortcuts-base'
import { useModifierHeld } from '@/hooks/use-modifier-held'
import { useTabActions } from '@/contexts/tabs'
import { newItemViewState } from '@/contexts/tabs/helpers'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { notesService } from '@/services/notes-service'
import { canvasService, type CanvasSummary } from '@/services/canvas-service'
import { useTasksOptional } from '@/contexts/tasks'
import { useAuth } from '@/contexts/auth-context'
import { SyncStatus } from '@/components/sync/sync-status'
import { useInboxList } from '@/hooks/use-inbox'
import type { SidebarItem, TabType } from '@/contexts/tabs/types'
import type { Project } from '@/data/tasks-data'
import type { AppPage } from '@/App'
import type { BookmarkWithItem } from '@/hooks/use-bookmarks'
import { BookmarkItemTypes } from '@memry/contracts/bookmarks-api'
import { getAllSupportedExtensions } from '@memry/shared/file-types'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { useFileDrop, FILE_DROP_FOLDER_ATTR } from '@/hooks/use-file-drop'
import { extractErrorMessage } from '@/lib/ipc-error'
import { revealNoteInSidebar } from '@/lib/reveal-in-sidebar'
import { useT } from '@memry/i18n/renderer'
import { useFirstRunTour } from '@/components/onboarding/use-first-run-tour'

const log = createLogger('Component:AppSidebar')

const mainNav: {
  title: string
  page: AppPage
  icon: typeof SidebarInbox
}[] = [
  { title: 'Home', page: 'home', icon: Home },
  { title: 'Inbox', page: 'inbox', icon: SidebarInbox },
  { title: 'Journal', page: 'journal', icon: SidebarJournal },
  { title: 'Calendar', page: 'calendar', icon: Calendar2 },
  { title: 'Tasks', page: 'tasks', icon: SidebarTasks },
  { title: 'Graph', page: 'graph', icon: ChartRelationship }
]

function SidebarHeaderContent() {
  // Empty h-9 spacer to reserve room for the viewport-fixed WindowControls
  // overlay (see App.tsx). Sidebar content starts below the chrome row.
  // drag-region: the chrome overlay is only --chrome-width (180px) wide, so the
  // strip from there to the sidebar's right edge must drag the window itself.
  return <SidebarHeader className="drag-region h-9 shrink-0" />
}

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  currentPage: AppPage
  viewCounts: Record<string, number>
}

export function AppSidebar({ currentPage, viewCounts, ...props }: AppSidebarProps) {
  return <AppSidebarInner currentPage={currentPage} viewCounts={viewCounts} {...props} />
}

/**
 * Inner sidebar component that has access to the drill-down context.
 */
function AppSidebarInner({ currentPage: _currentPage, viewCounts, ...props }: AppSidebarProps) {
  const { t: tPhaseF } = useT('common')
  const [tagsActions, setTagsActions] = useState<React.ReactNode>(null)
  const notesActionsRef = useRef<NotesTreeActions | null>(null)
  const [foldersExpanded, setFoldersExpanded] = useState(false)
  const sidebarScrollRef = useRef<HTMLDivElement>(null)
  const targetFolderRef = useRef('')

  const handleFileDrop = useCallback(async (paths: string[], targetFolder: string) => {
    try {
      // Where the file was dropped, not what happened to be selected.
      const result = await notesService.importFiles(paths, targetFolder)
      const tCommon = getI18n().getFixedT(null, 'common')

      if (result.imported > 0) {
        toast.success(tCommon('toast.filesImported', { count: result.imported }))
      }
      if (result.failed > 0) {
        toast.error(tCommon('toast.filesImportFailed', { count: result.failed }), {
          description: result.errors?.join('\n')
        })
      }
    } catch (err) {
      log.error('Failed to import dropped files', err)
      toast.error(
        extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'common')('phaseI.errors.failedToImportFiles')
        )
      )
    }
  }, [])

  const { setSelectedFolder } = useSelectedFolder()

  const handleTargetFolderChange = useCallback(
    (folder: string) => {
      targetFolderRef.current = folder
      setSelectedFolder(folder)
    },
    [setSelectedFolder]
  )

  const { isDraggingFiles, dropFolder, dropHandlers } = useFileDrop({ onDrop: handleFileDrop })

  // Calculate today's tasks count for Tasks badge in sidebar
  const todayTasksCount = useMemo(() => {
    return viewCounts['today'] || 0
  }, [viewCounts])

  // Get inbox items count (unfiled items + unviewed reminders)
  const { items: inboxItems } = useInboxList({ includeSnoozed: false })
  const inboxCount = useMemo(() => {
    if (!inboxItems) return 0
    // Count all items (unfiled by default) but for reminders, only count unviewed ones
    return inboxItems.filter((item) => item.type !== 'reminder' || !item.viewedAt).length
  }, [inboxItems])

  // Tab navigation hook
  const { openSidebarItem, isActiveItem } = useSidebarNavigation()
  const { isEnabled } = useFeatureFlags()

  // First-launch interactive tour (runs once per install)
  useFirstRunTour()

  // Tab actions for opening new notes (stable reference, won't cause re-renders)
  const { openTab } = useTabActions()

  const { settings: generalSettings } = useGeneralSettings()

  // Handle creating a new note (⌘N shortcut target)
  const handleNewNote = useCallback(async () => {
    const folder = generalSettings.createInSelectedFolder ? targetFolderRef.current : ''

    try {
      const result = await notesService.create({
        title: 'Untitled Note',
        content: '',
        folder: folder || undefined
      })

      if (result.success && result.note) {
        openTab({
          type: 'note',
          title: result.note.title || 'Untitled Note',
          icon: 'file-text',
          path: `/note/${result.note.id}`,
          entityId: result.note.id,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        })
        // The folder may have come from `defaultNoteFolder` rather than the
        // selection, so the created note is what says where to look.
        revealNoteInSidebar(result.note.id)
      }
    } catch (error) {
      log.error('Failed to create new note', error)
      toast.error(
        extractErrorMessage(
          error,
          getI18n().getFixedT(null, 'common')('phaseI.errors.failedToCreateNote')
        )
      )
    }
  }, [openTab, generalSettings.createInSelectedFolder])

  // Open a top-level section as a tab. Shared by sidebar clicks and the
  // ⌘/Ctrl+number shortcuts so both land the user in exactly the same state.
  const navigateToPage = useCallback(
    (page: AppPage, options?: OpenSidebarItemOptions) => {
      // Map page to tab type and title
      const pageToTabType: Record<AppPage, TabType> = {
        home: 'home',
        inbox: 'inbox',
        calendar: 'calendar',
        journal: 'journal',
        tasks: 'tasks',
        graph: 'graph'
      }
      const pageToTitle: Record<AppPage, string> = {
        home: 'Home',
        inbox: 'Inbox',
        calendar: 'Calendar',
        journal: 'Journal',
        tasks: 'Tasks',
        graph: 'Graph'
      }

      // Land the user ready-to-act: Inbox focuses capture, Tasks opens the default
      // project + focuses quick-add. Calendar deliberately gets NO new-event popover
      // from the sidebar — that only fires from the New menu and the new-tab +.
      const pageToViewState: Partial<Record<AppPage, Record<string, unknown>>> = {
        inbox: newItemViewState('inbox'),
        tasks: newItemViewState('tasks')
      }

      // Open as tab in active pane
      const item: SidebarItem = {
        type: pageToTabType[page],
        title: pageToTitle[page],
        path: `/${page}`,
        viewState: pageToViewState[page]
      }
      openSidebarItem(item, options)
    },
    [openSidebarItem]
  )

  const handleNavClick = (page: AppPage) => (e: React.MouseEvent) => {
    e.preventDefault()
    // ⌘/Ctrl-click asks for a second tab, +Shift asks for it without focus.
    // Nav pages are singletons, so openSidebarItem declines to duplicate them and
    // focuses the one that exists — the modifiers still matter for the pages that
    // are not singletons, and the gesture stays consistent across the sidebar.
    const inNewTab = e.metaKey || e.ctrlKey
    navigateToPage(page, { inNewTab, inBackground: e.shiftKey && inNewTab })
  }

  // Sections visible in the sidebar (Home always; others gated by feature flags).
  // Drives both the rendered numbers and the ⌘/Ctrl+number shortcut mapping so
  // they never drift.
  const visibleNav = useMemo(
    () => mainNav.filter((item) => item.page === 'home' || isEnabled(item.page)),
    [isEnabled]
  )

  // ⌘/Ctrl + 1..9 → open the Nth visible section (matches the on-icon numbers).
  // allowInInput + capture so it also fires while the note editor, inbox
  // composer, or tasks quick-add input is focused (those pages auto-focus an
  // input on open and some stop keydown propagation).
  const sectionShortcuts = useMemo<KeyboardShortcut[]>(
    () =>
      visibleNav.slice(0, 9).map((item, i) => ({
        key: String(i + 1),
        modifiers: { meta: true },
        action: () => navigateToPage(item.page),
        description: `Go to ${item.title}`,
        allowInInput: true
      })),
    [visibleNav, navigateToPage]
  )
  useKeyboardShortcuts(sectionShortcuts, { capture: true })

  // While the modifier is held, section icons swap to their shortcut number.
  const isModifierHeld = useModifierHeld()

  // Handle bookmark click - navigate to bookmarked item
  const handleBookmarkClick = useCallback(
    (bookmark: BookmarkWithItem) => {
      // Folders open as a folder-view tab; tags open the tag tab.
      if (bookmark.itemType === BookmarkItemTypes.FOLDER) {
        openTab({
          type: 'folder',
          title: bookmark.itemTitle || 'Folder',
          icon: 'folder',
          emoji: bookmark.itemMeta?.emoji,
          path: `/folder/${encodeURIComponent(bookmark.itemId)}`,
          entityId: bookmark.itemId,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        })
        return
      }
      if (bookmark.itemType === BookmarkItemTypes.TAG) {
        openSidebarItem({
          type: 'tag',
          title: bookmark.itemId,
          path: '/tags/' + bookmark.itemId,
          entityId: bookmark.itemId,
          color: ''
        })
        return
      }

      // Map bookmark item type to tab type
      const itemTypeToTabType: Record<string, TabType> = {
        [BookmarkItemTypes.NOTE]: 'note',
        [BookmarkItemTypes.JOURNAL]: 'journal',
        [BookmarkItemTypes.TASK]: 'tasks'
      }

      const tabType = itemTypeToTabType[bookmark.itemType] || 'note'

      // Open the bookmarked item in a tab
      const item: SidebarItem = {
        type: tabType,
        title: bookmark.itemTitle || 'Untitled',
        path: bookmark.itemMeta?.path || `/${bookmark.itemType}/${bookmark.itemId}`,
        entityId: bookmark.itemId
      }
      openSidebarItem(item)
    },
    [openSidebarItem, openTab]
  )

  // Open a canvas in a tab (entityId dedupe keeps it to one tab per canvas)
  const handleCanvasOpen = useCallback(
    (canvas: Pick<CanvasSummary, 'id' | 'title'>) => {
      openTab({
        type: 'canvas',
        title: canvas.title || tPhaseF('canvas.untitled'),
        icon: 'pen-tool',
        path: `/canvas/${canvas.id}`,
        entityId: canvas.id,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    },
    [openTab, tPhaseF]
  )

  // The canvas tree reports where the user is looking; the section header's `+`
  // sits outside the tree and would otherwise always land at the root.
  const canvasTargetFolderRef = useRef<string | null>(null)
  const [canvasCount, setCanvasCount] = useState(0)

  // A folder row's own menu can only ever create a CHILD folder, so the root
  // needs a control that sits outside the tree — the same shape NOTES uses for
  // its own "New folder".
  const canvasTreeRef = useRef<CanvasTreeActions | null>(null)

  const handleCanvasTargetFolderChange = useCallback((folder: string | null) => {
    canvasTargetFolderRef.current = folder
  }, [])

  const handleCreateCanvas = useCallback(async () => {
    try {
      const canvas = await canvasService.create({ folder: canvasTargetFolderRef.current })
      handleCanvasOpen(canvas)
    } catch (error) {
      log.error('Failed to create canvas', error)
      trackRendererError('canvas_create', error)
      toast.error(
        extractErrorMessage(error, getI18n().getFixedT(null, 'common')('canvas.createFailed'))
      )
    }
  }, [handleCanvasOpen])

  // Active (non-archived) projects, sourced from the same TasksProvider context
  // the Tasks page reads from. Nullable accessor so the sidebar still renders
  // if it's ever mounted outside a TasksProvider (see app-sidebar.test.tsx).
  const tasksContext = useTasksOptional()
  const activeProjects = useMemo(
    () => (tasksContext?.projects ?? []).filter((project) => !project.isArchived),
    [tasksContext?.projects]
  )

  // Open a project's Project Home page (entityId dedupe keeps it to one tab per project)
  const handleProjectClick = useCallback(
    (projectId: string) => {
      const project = activeProjects.find((p) => p.id === projectId)
      openSidebarItem({
        type: 'project',
        title: project?.name ?? '',
        icon: 'folder',
        path: `/project/${projectId}`,
        entityId: projectId
      })
    },
    [activeProjects, openSidebarItem]
  )

  // Create/edit project — reuses the same ProjectModal + TasksProvider mutations
  // the Tasks page uses, so the sidebar's gear icon and empty-state "create
  // project" button are fully functional rather than dead controls.
  const { t: tTasks } = useT('tasks')
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)

  const handleCreateProject = useCallback(() => {
    setEditingProject(null)
    setIsProjectModalOpen(true)
  }, [])

  const handleEditProject = useCallback((project: Project) => {
    setEditingProject(project)
    setIsProjectModalOpen(true)
  }, [])

  const handleProjectModalClose = useCallback(() => {
    setIsProjectModalOpen(false)
    setEditingProject(null)
  }, [])

  const handleSaveProject = useCallback(
    async (project: Project) => {
      if (!tasksContext) return
      try {
        if (editingProject) {
          await tasksContext.updateProject(project.id, project)
          toast.success(tTasks('toasts.projectUpdated'))
        } else {
          await tasksContext.addProject(project)
          toast.success(tTasks('toasts.projectCreated'))
        }
      } catch (error) {
        log.error('Failed to save project:', error)
        toast.error(tTasks('toasts.projectSaveError'))
      }
    },
    [tasksContext, editingProject, tTasks]
  )

  const handleDeleteProject = useCallback(() => {
    if (!tasksContext || !editingProject) return
    const projectId = editingProject.id
    tasksContext
      .deleteProject(projectId)
      .then(() => toast.success(tTasks('toasts.projectDeleted')))
      .catch((error: unknown) => {
        log.error('Failed to delete project:', error)
        toast.error(tTasks('toasts.projectDeleteError'))
      })
  }, [tasksContext, editingProject, tTasks])

  // Archive/delete/reorder have no visible control in SortableProjectItem today
  // (only the edit gear and the empty-state create button render — see
  // sortable-project-item.tsx and projects-empty-state.tsx); delete lives on
  // ProjectModal's own delete button, wired above. These no-ops satisfy the
  // required prop types without a reachable dead control.
  const noopProjectAction = useCallback((): void => {}, [])

  // Main sidebar content (shown when not drilling down)
  const mainContent = (
    <>
      {/* Separator between nav and collections */}
      <div className="h-px bg-sidebar-border shrink-0 mx-3 my-2 group-data-[collapsible=icon]:mx-1.5" />

      {/* SCROLLABLE SECTION - Collections, Bookmarks, Tags — entire area is drop target */}
      <div
        ref={sidebarScrollRef}
        data-tour="sidebar-collections"
        className="relative flex-1 min-h-0 overflow-y-auto scrollbar-thin group-data-[collapsible=icon]:overflow-hidden"
        // Anything dropped outside a folder row lands in the vault root.
        {...{ [FILE_DROP_FOLDER_ATTR]: '' }}
        {...dropHandlers}
      >
        {/* COLLECTIONS Section */}
        <SidebarSection
          id="collections"
          label={tPhaseF('phaseF.componentsAppSidebar.collections')}
          defaultExpanded={false}
          actions={
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
                      if (foldersExpanded) {
                        notesActionsRef.current?.collapseAll()
                      } else {
                        notesActionsRef.current?.expandAll()
                      }
                      setFoldersExpanded(!foldersExpanded)
                    }}
                    className="p-0.5 rounded cursor-pointer hover:bg-sidebar-accent transition-colors"
                    aria-label={foldersExpanded ? 'Collapse all folders' : 'Expand all folders'}
                  >
                    {foldersExpanded ? (
                      <ChevronsDown className="size-3.5 text-sidebar-muted hover:text-sidebar-foreground" />
                    ) : (
                      <ChevronsUp className="size-3.5 text-sidebar-muted hover:text-sidebar-foreground" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {foldersExpanded ? 'Collapse all folders' : 'Expand all folders'}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => notesActionsRef.current?.createNote()}
                    className="p-0.5 rounded cursor-pointer hover:bg-sidebar-accent transition-colors"
                    aria-label={tPhaseF('phaseF.componentsAppSidebar.newNote')}
                  >
                    <FilePlus className="size-3.5 text-sidebar-muted hover:text-sidebar-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {tPhaseF('phaseF.componentsAppSidebar.newNote2')}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => notesActionsRef.current?.createFolder()}
                    className="p-0.5 rounded cursor-pointer hover:bg-sidebar-accent transition-colors"
                    aria-label={tPhaseF('phaseF.componentsAppSidebar.newFolder')}
                  >
                    <FolderPlus className="size-3.5 text-sidebar-muted hover:text-sidebar-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {tPhaseF('phaseF.componentsAppSidebar.newFolder2')}
                </TooltipContent>
              </Tooltip>
            </>
          }
        >
          <NotesTree
            ref={notesActionsRef}
            onTargetFolderChange={handleTargetFolderChange}
            fileDropFolder={isDraggingFiles ? dropFolder : null}
            scrollContainerRef={sidebarScrollRef as React.RefObject<HTMLElement>}
          />
        </SidebarSection>

        {/* PROJECTS Section */}
        <SidebarSection
          id="projects"
          label={tPhaseF('phaseF.componentsAppSidebar.projects')}
          defaultExpanded={false}
          totalCount={activeProjects.length}
          // With no projects the section body is an empty-state CTA nobody sees
          // while the section is collapsed — which it is by default. Pinning the
          // "+" open is then the only entry point on screen.
          actionsAlwaysVisible={activeProjects.length === 0}
          actions={
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCreateProject}
                  className="p-0.5 rounded cursor-pointer hover:bg-sidebar-accent transition-colors"
                  aria-label={tPhaseF('phaseF.componentsAppSidebar.newProject')}
                >
                  <Plus className="size-3.5 text-sidebar-muted hover:text-sidebar-foreground" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {tPhaseF('phaseF.componentsAppSidebar.newProject')}
              </TooltipContent>
            </Tooltip>
          }
        >
          <SortableProjectList
            projects={activeProjects}
            activeProjectId={null}
            onProjectClick={handleProjectClick}
            onProjectEdit={handleEditProject}
            onProjectArchive={noopProjectAction}
            onProjectDelete={noopProjectAction}
            onProjectsReorder={noopProjectAction}
            onCreateProject={handleCreateProject}
          />
        </SidebarSection>

        {/* BOOKMARKS Section */}
        <SidebarSection
          id="bookmarks"
          label={tPhaseF('phaseF.componentsAppSidebar.bookmarks')}
          defaultExpanded={false}
        >
          <SidebarBookmarkList maxVisible={6} onBookmarkClick={handleBookmarkClick} />
        </SidebarSection>

        {/* CANVASES Section (gated by the spatialCanvas flag, default on) */}
        {isEnabled('spatialCanvas') && (
          <SidebarSection
            id="canvases"
            label={tPhaseF('canvas.sectionLabel')}
            defaultExpanded={false}
            totalCount={canvasCount}
            actions={
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => void handleCreateCanvas()}
                      className="p-0.5 rounded cursor-pointer hover:bg-sidebar-accent transition-colors"
                      aria-label={tPhaseF('canvas.newCanvas')}
                    >
                      <Plus className="size-3.5 text-sidebar-muted hover:text-sidebar-foreground" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {tPhaseF('canvas.newCanvas')}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => canvasTreeRef.current?.createFolder()}
                      className="p-0.5 rounded cursor-pointer hover:bg-sidebar-accent transition-colors"
                      aria-label={tPhaseF('canvas.newCanvasFolder')}
                    >
                      <FolderPlus className="size-3.5 text-sidebar-muted hover:text-sidebar-foreground" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {tPhaseF('canvas.newCanvasFolder')}
                  </TooltipContent>
                </Tooltip>
              </>
            }
          >
            <CanvasTree
              ref={canvasTreeRef}
              onCanvasClick={handleCanvasOpen}
              onCountChange={setCanvasCount}
              onTargetFolderChange={handleCanvasTargetFolderChange}
            />
          </SidebarSection>
        )}

        {/* TAGS Section */}
        <SidebarSection
          id="tags"
          label={tPhaseF('phaseF.componentsAppSidebar.tags')}
          defaultExpanded={false}
          actions={tagsActions}
        >
          <SidebarTagList maxVisible={6} onActionsReady={setTagsActions} />
        </SidebarSection>

        {/*
          Drop affordance. It never takes pointer events and never covers the
          tree: the row under the cursor has to stay both the drop target and
          visible, or there is no way to aim at a folder.
        */}
        <div
          className={cn(
            'pointer-events-none absolute inset-0 z-50 transition-opacity duration-150',
            isDraggingFiles ? 'opacity-100' : 'opacity-0 invisible'
          )}
        >
          <div className="absolute inset-1 rounded-md border-2 border-dashed border-primary/50" />
          <div className="absolute inset-x-3 bottom-3 flex flex-col items-center gap-0.5 rounded-md border border-primary/40 bg-background/95 px-3 py-2 shadow-sm">
            <span className="flex items-center gap-2 text-sm font-medium">
              <Upload className="size-4 text-primary" />
              {tPhaseF('phaseF.componentsAppSidebar.dropFilesToImport')}
            </span>
            <span className="max-w-full truncate text-xs font-medium text-primary">
              {dropFolder || tPhaseF('phaseF.componentsAppSidebar.dropFilesIntoVaultRoot')}
            </span>
            <span className="line-clamp-2 text-center text-[10px] leading-tight text-muted-foreground">
              {getAllSupportedExtensions().join(', ')}
            </span>
          </div>
        </div>
      </div>
    </>
  )

  const { state: authState } = useAuth()
  const { open: openSettings } = useSettingsModal()

  const handleSyncClick = useCallback(() => {
    openSettings('account')
  }, [openSettings])

  const settingsLabel = tPhaseF('phaseF.componentsVaultSwitcher.settings')

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeaderContent />
      <SidebarContent className="flex flex-col overflow-hidden gap-0">
        {/* Quick Action: New — persistent, stays visible during drill-down */}
        <div className="shrink-0 flex items-center px-3 pt-2 pb-0 group-data-[collapsible=icon]:hidden">
          <div className="flex flex-1 items-center h-[30px] rounded-[5px] bg-sidebar-surface overflow-hidden">
            <button
              type="button"
              data-tour="new-note"
              onClick={() => void handleNewNote()}
              className="flex flex-1 items-center justify-center gap-2 h-full hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
              title={tPhaseF('phaseF.componentsAppSidebar.newNoteN')}
            >
              <Plus className="size-[15px] text-muted-foreground/70" />
              <span className="text-[13px] text-muted-foreground/70 font-normal">
                {tPhaseF('phaseF.componentsAppSidebar.new')}
              </span>
            </button>
            <Picker>
              <Picker.Trigger asChild>
                <button
                  type="button"
                  aria-label={tPhaseF('phaseF.componentsAppSidebar.newItemMenu')}
                  className="flex h-full w-7 shrink-0 items-center justify-center border-s border-black/[0.06] dark:border-white/[0.08] hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
                >
                  <ChevronDown className="size-3.5 text-muted-foreground/70" />
                </button>
              </Picker.Trigger>
              <Picker.Content width={200} align="end" side="bottom">
                <NewItemMenuItems
                  actions={{
                    onNewNote: () => void handleNewNote(),
                    onJournal: () =>
                      openSidebarItem({ type: 'journal', title: 'Journal', path: '/journal' }),
                    onCalendar: () =>
                      openSidebarItem({
                        type: 'calendar',
                        title: 'Calendar',
                        path: '/calendar',
                        viewState: newItemViewState('calendar')
                      }),
                    onInbox: () =>
                      openSidebarItem({
                        type: 'inbox',
                        title: 'Inbox',
                        path: '/inbox',
                        viewState: newItemViewState('inbox')
                      }),
                    onTasks: () =>
                      openSidebarItem({
                        type: 'tasks',
                        title: 'Tasks',
                        path: '/tasks',
                        viewState: newItemViewState('tasks')
                      }),
                    onTags: () => openSidebarItem({ type: 'tags', title: 'Tags', path: '/tags' })
                  }}
                />
              </Picker.Content>
            </Picker>
          </div>
        </div>
        <SidebarNav
          items={visibleNav}
          isActive={isActiveItem}
          onNavClick={handleNavClick}
          isModifierHeld={isModifierHeld}
          inboxCount={inboxCount}
          todayTasksCount={todayTasksCount}
        />
        <SidebarDrillDownContainer>{mainContent}</SidebarDrillDownContainer>
      </SidebarContent>
      <SidebarFooter className="gap-0 p-2">
        <SidebarUpdateButton />
        <div className="flex items-center gap-1">
          {authState.status === 'authenticated' ? (
            <div className="shrink-0 w-7 [&>button]:w-7 [&>button]:justify-center">
              <SyncStatus onOpenSettings={handleSyncClick} iconOnly />
            </div>
          ) : authState.status === 'checking' ? null : (
            <button
              type="button"
              data-tour="sync-status"
              onClick={handleSyncClick}
              aria-label={tPhaseF('phaseF.componentsAppSidebar.syncDisabled')}
              title={tPhaseF('phaseF.componentsAppSidebar.syncDisabled2')}
              className="shrink-0 size-7 rounded flex items-center justify-center hover:bg-sidebar-accent text-muted-foreground transition-colors"
            >
              <CloudOff className="size-4" />
            </button>
          )}
          <div className="flex-1 min-w-0">
            <VaultSwitcher />
          </div>
          <SidebarFeedbackButton />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-tour="settings"
                onClick={() => openSettings()}
                aria-label={settingsLabel}
                title={settingsLabel}
                className="shrink-0 size-7 rounded flex items-center justify-center hover:bg-sidebar-accent text-muted-foreground transition-colors"
              >
                <Settings className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {settingsLabel}
            </TooltipContent>
          </Tooltip>
        </div>
      </SidebarFooter>
      <SidebarRail />
      <ProjectModal
        isOpen={isProjectModalOpen}
        onClose={handleProjectModalClose}
        onSave={(project) => void handleSaveProject(project)}
        onDelete={handleDeleteProject}
        project={editingProject}
      />
    </Sidebar>
  )
}
