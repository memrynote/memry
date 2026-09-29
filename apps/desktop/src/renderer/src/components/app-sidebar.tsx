'use client'

import * as React from 'react'
import { useMemo, useState, useCallback, useRef } from 'react'
import { getI18n } from 'react-i18next'
import { ChevronsDown, ChevronsUp, FilePlus, FolderPlus, CloudOff, Plus, Upload } from '@/lib/icons'
import {
  PageCalendarIcon,
  PageGraphIcon,
  PageHomeIcon,
  PageInboxIcon,
  PageJournalIcon,
  PageTasksIcon
} from '@/lib/icons/page-icons'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import {
  SidebarVaultDots,
  SidebarVaultPager,
  useSidebarVaultPages
} from '@/components/sidebar/sidebar-vault-paging'
import { Sidebar, SidebarContent, SidebarFooter, SidebarRail } from '@/components/ui/sidebar'
import { AppRail, type AppRailItem } from '@/components/sidebar/app-rail'
import { SidebarPanelHeader } from '@/components/sidebar/sidebar-panel-header'
import { SidebarSection } from '@/components/sidebar-section'
import { NotesTree, type NotesTreeActions } from '@/components/notes-tree'
import { SidebarTagList } from '@/components/sidebar/sidebar-tag-list'
import { SidebarUpdateRow } from '@/components/sidebar/sidebar-update-row'
import { SidebarFeedbackButton } from '@/components/sidebar/sidebar-feedback-button'
import { SidebarSettingsButton } from '@/components/sidebar/sidebar-settings-button'
import { DockButton } from '@/components/sidebar/footer-dock'
import { GithubStarCard } from '@/components/onboarding/github-star-card'
import { SidebarBookmarkList } from '@/components/sidebar/sidebar-bookmark-list'
import { CanvasTree, type CanvasTreeActions } from '@/components/sidebar/canvas-tree/canvas-tree'
import { SidebarSortPicker } from '@/components/sidebar/sidebar-sort-picker'
import { useSidebarSortLabels } from '@/components/sidebar/use-sidebar-sort-labels'
import { useSidebarSortMode } from '@/hooks/use-sidebar-sort-mode'
import { useSidebarTreeViewOptions } from '@/hooks/use-sidebar-tree-view-options'
import { compareListItems, isReorderable } from '@/components/sidebar/sidebar-list-sort'
import { SortableProjectList } from '@/components/sidebar/sortable-project-list'
import { SidebarSectionAction } from '@/components/sidebar/sidebar-section-action'
import { SortableSidebarSections } from '@/components/sidebar/sortable-sidebar-sections'
import { resolveSidebarSectionOrder } from '@/components/sidebar/sidebar-section-order'
import { ProjectModal } from '@/components/tasks/project-modal'
import { SidebarDrillDownContainer } from '@/components/sidebar/sidebar-drill-down-container'
import { useSelectedFolder } from '@/contexts/selected-folder-context'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useSidebarRailOrder, useSidebarSectionOrder } from '@/hooks/use-sidebar-section-order'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { useOpenPage } from '@/hooks/use-open-target'
import type { OpenSidebarItemOptions } from '@/hooks/use-sidebar-navigation'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { useKeyboardShortcuts, type KeyboardShortcut } from '@/hooks/use-keyboard-shortcuts-base'
import { useModifierHeld } from '@/hooks/use-modifier-held'
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
import { getAllSupportedExtensions, getExtension, getFileType } from '@memry/shared/file-types'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { useFileDrop, FILE_DROP_FOLDER_ATTR } from '@/hooks/use-file-drop'
import { extractErrorMessage } from '@/lib/ipc-error'
import { revealNoteInSidebar } from '@/lib/reveal-in-sidebar'
import { useT } from '@memry/i18n/renderer'
import { useFirstRunTour } from '@/components/onboarding/use-first-run-tour'

const log = createLogger('Component:AppSidebar')

// Loaded through import() like SettingsView in App.tsx: `@/pages/settings` pulls
// in every settings section, and a static import here would keep all of them in
// the entry chunk while settings is closed.
const LazySettingsNav = React.lazy(async () => ({
  default: (await import('@/pages/settings')).SettingsNav
}))

const mainNav: AppRailItem[] = [
  { title: 'Home', page: 'home', icon: PageHomeIcon },
  { title: 'Inbox', page: 'inbox', icon: PageInboxIcon },
  { title: 'Journal', page: 'journal', icon: PageJournalIcon },
  { title: 'Calendar', page: 'calendar', icon: PageCalendarIcon },
  { title: 'Tasks', page: 'tasks', icon: PageTasksIcon },
  { title: 'Graph', page: 'graph', icon: PageGraphIcon }
]

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
  const { mode: collectionsSortMode, setMode: setCollectionsSortMode } =
    useSidebarSortMode('collections')
  const { mode: projectsSortMode, setMode: setProjectsSortMode } = useSidebarSortMode('projects')
  const { mode: bookmarksSortMode, setMode: setBookmarksSortMode } = useSidebarSortMode('bookmarks')
  const { mode: canvasesSortMode, setMode: setCanvasesSortMode } = useSidebarSortMode('canvases')
  const sortLabels = useSidebarSortLabels()
  const treeViewOptions = useSidebarTreeViewOptions()
  const { t: tNotes } = useT('notes')
  const [tagsActions, setTagsActions] = useState<React.ReactNode>(null)
  const notesActionsRef = useRef<NotesTreeActions | null>(null)
  const [foldersExpanded, setFoldersExpanded] = useState(false)
  const sidebarScrollRef = useRef<HTMLDivElement>(null)
  const targetFolderRef = useRef('')

  const { showFiles } = treeViewOptions
  const handleFileDrop = useCallback(
    async (paths: string[], targetFolder: string) => {
      try {
        // Where the file was dropped, not what happened to be selected.
        const result = await notesService.importFiles(paths, targetFolder)
        const tCommon = getI18n().getFixedT(null, 'common')

        if (result.imported > 0) {
          // With "Show files" off a dropped PDF or image lands and then does not
          // appear, which reads as a failed import unless the toast says why.
          const hidesSomeImports =
            !showFiles &&
            paths.some((path) => (getFileType(getExtension(path)) ?? 'markdown') !== 'markdown')
          const message = tCommon('toast.filesImported', { count: result.imported })
          if (hidesSomeImports) {
            toast.success(message, { description: tCommon('toast.filesHiddenInSidebar') })
          } else {
            toast.success(message)
          }
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
    },
    [showFiles]
  )

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
  // Plain opens/creations honour the "clicking a page opens a new tab"
  // preference (#1644); openSidebarItem carries it internally for its rows.
  const { openPage } = useOpenPage()
  const { isEnabled } = useFeatureFlags()

  // First-launch interactive tour (runs once per install)
  useFirstRunTour()

  // Tab actions for opening new notes (stable reference, won't cause re-renders)

  const { settings: generalSettings } = useGeneralSettings()
  const { open: openSettings, isOpen: isSettingsOpen, close: closeSettings } = useSettingsModal()
  const { order: sectionOrder, setOrder: setSectionOrder } = useSidebarSectionOrder()
  const { order: railOrder, setOrder: setRailOrder } = useSidebarRailOrder()

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
        openPage({
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
        // selection, so the created note is what says where to look. `rename`
        // opens the row's name input once it gets there, so naming the note is
        // not a separate second step (#2272).
        revealNoteInSidebar(result.note.id, { rename: true })
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
  }, [openPage, generalSettings.createInSelectedFolder])

  // Open a top-level section as a tab. Shared by sidebar clicks and the
  // ⌘/Ctrl+number shortcuts so both land the user in exactly the same state.
  const navigateToPage = useCallback(
    (page: AppPage, options?: OpenSidebarItemOptions) => {
      // Settings covers the workspace; going to a page leaves it, even when the
      // page's tab is already the active one.
      if (isSettingsOpen) closeSettings()

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
    [openSidebarItem, isSettingsOpen, closeSettings]
  )

  const handleNavClick = (page: AppPage) => (e: React.MouseEvent) => {
    e.preventDefault()
    // ⌘/Ctrl-click asks for a second tab, +Shift asks for it without focus.
    // Since #1644 that holds for the singleton nav pages too: an explicit
    // gesture mints a real second Home/Inbox/… instead of being downgraded to
    // "focus the one that exists".
    const inNewTab = e.metaKey || e.ctrlKey
    navigateToPage(page, { inNewTab, inBackground: e.shiftKey && inNewTab })
  }

  // Read on mousedown: a middle click never produces a `click` event, so the
  // gesture is invisible to onClick.
  const handleNavMiddleClick = (page: AppPage) => (e: React.MouseEvent) => {
    if (e.button !== 1) return
    e.preventDefault()
    navigateToPage(page, { inNewTab: true, inBackground: true })
  }

  // Sections visible in the sidebar (Home always; others gated by feature flags).
  // Drives both the rendered numbers and the ⌘/Ctrl+number shortcut mapping so
  // they never drift.
  // In the user's dragged order (`sidebar.railOrder`, per vault, synced).
  const visibleNav = useMemo(() => {
    const enabled = mainNav.filter((item) => item.page === 'home' || isEnabled(item.page))
    const byPage = new Map(enabled.map((item) => [item.page as string, item]))
    return resolveSidebarSectionOrder([...byPage.keys()], railOrder).flatMap((page) => {
      const item = byPage.get(page)
      return item ? [item] : []
    })
  }, [isEnabled, railOrder])

  // Flag-hidden pages keep their slot in the saved order: the visible pages
  // take the visible slots in their new order, hidden ones stay put.
  const handleRailReorder = useCallback(
    (pages: string[]) => {
      const visible = new Set(pages)
      const queue = [...pages]
      const full = resolveSidebarSectionOrder(
        mainNav.map((item) => item.page),
        railOrder
      )
      setRailOrder(full.map((page) => (visible.has(page) ? (queue.shift() ?? page) : page)))
    },
    [railOrder, setRailOrder]
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

  // Open a canvas in a tab (entityId dedupe keeps it to one tab per canvas)
  const handleCanvasOpen = useCallback(
    (canvas: Pick<CanvasSummary, 'id' | 'title'>) => {
      openPage({
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
    [openPage, tPhaseF]
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
  const activeProjects = useMemo(() => {
    const active = (tasksContext?.projects ?? []).filter((project) => !project.isArchived)
    // The context already hands these over in stored-position order, so the
    // index IS the position — there is no position field on the renderer's
    // Project to read instead.
    return active
      .map((project, position) => ({
        project,
        name: project.name,
        position,
        // Optional: a Project handed over without a creation date sorts by its
        // stored position instead of crashing the whole section.
        created: project.createdAt?.getTime?.()
      }))
      .sort(compareListItems(projectsSortMode))
      .map((entry) => entry.project)
  }, [tasksContext?.projects, projectsSortMode])

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

  // Sections in their default order. What the user dragged lives in
  // `sidebar.sectionOrder` (per vault, synced); a saved order that names a
  // section this build does not render is filtered, and a section the saved
  // order never saw falls back to its slot here (#1645).
  const sectionLabels: Record<string, string> = {
    collections: tPhaseF('phaseF.componentsAppSidebar.collections'),
    projects: tPhaseF('phaseF.componentsAppSidebar.projects'),
    bookmarks: tPhaseF('phaseF.componentsAppSidebar.bookmarks'),
    canvases: tPhaseF('canvas.sectionLabel'),
    tags: tPhaseF('phaseF.componentsAppSidebar.tags')
  }

  const sectionNodes: Record<string, React.ReactNode> = {
    collections: (
      <SidebarSection
        id="collections"
        label={tPhaseF('phaseF.componentsAppSidebar.collections')}
        defaultExpanded={false}
        actions={
          <>
            <SidebarSortPicker
              surface="collections"
              mode={collectionsSortMode}
              onModeChange={(next) => void setCollectionsSortMode(next)}
              labels={sortLabels.labels}
              triggerLabel={sortLabels.triggerLabel(
                tPhaseF('phaseF.componentsAppSidebar.collections'),
                collectionsSortMode
              )}
              viewOptionsLabel={tNotes('tree.viewOptions.label')}
              viewOptions={[
                {
                  id: 'notes-first',
                  label: tNotes('tree.viewOptions.notesFirst'),
                  checked: treeViewOptions.notesFirst,
                  onCheckedChange: treeViewOptions.setNotesFirst
                },
                {
                  id: 'show-files',
                  label: tNotes('tree.viewOptions.showFiles'),
                  checked: treeViewOptions.showFiles,
                  onCheckedChange: treeViewOptions.setShowFiles
                }
              ]}
            />
            <SidebarSectionAction
              icon={foldersExpanded ? ChevronsDown : ChevronsUp}
              label={foldersExpanded ? 'Collapse all folders' : 'Expand all folders'}
              onClick={() => {
                if (foldersExpanded) {
                  notesActionsRef.current?.collapseAll()
                } else {
                  notesActionsRef.current?.expandAll()
                }
                setFoldersExpanded(!foldersExpanded)
              }}
            />
            <SidebarSectionAction
              icon={FilePlus}
              label={tPhaseF('phaseF.componentsAppSidebar.newNote')}
              tooltip={tPhaseF('phaseF.componentsAppSidebar.newNote2')}
              onClick={() => notesActionsRef.current?.createNote()}
            />
            <SidebarSectionAction
              icon={FolderPlus}
              label={tPhaseF('phaseF.componentsAppSidebar.newFolder')}
              tooltip={tPhaseF('phaseF.componentsAppSidebar.newFolder2')}
              onClick={() => notesActionsRef.current?.createFolder()}
            />
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
    ),
    projects: (
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
          <>
            <SidebarSortPicker
              surface="projects"
              mode={projectsSortMode}
              onModeChange={(next) => void setProjectsSortMode(next)}
              labels={sortLabels.labels}
              triggerLabel={sortLabels.triggerLabel(
                tPhaseF('phaseF.componentsAppSidebar.projects'),
                projectsSortMode
              )}
            />
            <SidebarSectionAction
              icon={Plus}
              label={tPhaseF('phaseF.componentsAppSidebar.newProject')}
              onClick={handleCreateProject}
            />
          </>
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
          reorderDisabled={!isReorderable(projectsSortMode)}
        />
      </SidebarSection>
    ),
    bookmarks: (
      <SidebarSection
        id="bookmarks"
        label={tPhaseF('phaseF.componentsAppSidebar.bookmarks')}
        defaultExpanded={false}
        actions={
          <SidebarSortPicker
            surface="bookmarks"
            mode={bookmarksSortMode}
            onModeChange={(next) => void setBookmarksSortMode(next)}
            labels={sortLabels.labels}
            triggerLabel={sortLabels.triggerLabel(
              tPhaseF('phaseF.componentsAppSidebar.bookmarks'),
              bookmarksSortMode
            )}
          />
        }
      >
        <SidebarBookmarkList maxVisible={6} sortMode={bookmarksSortMode} />
      </SidebarSection>
    ),
    // Canvases stays out of the map entirely while its flag is off, so the
    // saved order simply has no slot for it; flipping the flag back on drops
    // it into its default place again.
    ...(isEnabled('spatialCanvas')
      ? {
          canvases: (
            <SidebarSection
              id="canvases"
              label={tPhaseF('canvas.sectionLabel')}
              defaultExpanded={false}
              totalCount={canvasCount}
              actions={
                <>
                  <SidebarSortPicker
                    surface="canvases"
                    mode={canvasesSortMode}
                    onModeChange={(next) => void setCanvasesSortMode(next)}
                    labels={sortLabels.labels}
                    triggerLabel={sortLabels.triggerLabel(
                      tPhaseF('canvas.sectionLabel'),
                      canvasesSortMode
                    )}
                  />
                  <SidebarSectionAction
                    icon={Plus}
                    label={tPhaseF('canvas.newCanvas')}
                    onClick={() => void handleCreateCanvas()}
                  />
                  <SidebarSectionAction
                    icon={FolderPlus}
                    label={tPhaseF('canvas.newCanvasFolder')}
                    onClick={() => canvasTreeRef.current?.createFolder()}
                  />
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
          )
        }
      : {}),
    tags: (
      <SidebarSection
        id="tags"
        label={tPhaseF('phaseF.componentsAppSidebar.tags')}
        defaultExpanded={false}
        actions={tagsActions}
      >
        <SidebarTagList maxVisible={6} onActionsReady={setTagsActions} />
      </SidebarSection>
    )
  }

  const sectionList = (
    <SortableSidebarSections
      sections={resolveSidebarSectionOrder(Object.keys(sectionNodes), sectionOrder).map((id) => ({
        id,
        label: sectionLabels[id],
        node: sectionNodes[id]
      }))}
      onReorder={setSectionOrder}
    />
  )

  // Main sidebar content (shown when not drilling down)
  const mainContent = (
    <>
      {/* SCROLLABLE SECTION - Collections, Bookmarks, Tags — entire area is drop target */}
      <div
        ref={sidebarScrollRef}
        data-tour="sidebar-collections"
        // `scroll-pt-6` matches the sticky section header (SidebarSection,
        // h-6): a row focused or scrolled into view natively lands below it
        // instead of under it.
        // `scrollbar-gutter: stable` reserves the scrollbar's width up front.
        // Without it, content that grows just past the fold (e.g. expanding
        // Tags) makes the scrollbar appear, the rows narrow by its width, and
        // the layout can flip back and forth between the two widths.
        className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable] scroll-pt-6 scrollbar-thin group-data-[collapsible=icon]:overflow-hidden"
        // Anything dropped outside a folder row lands in the vault root.
        {...{ [FILE_DROP_FOLDER_ATTR]: '' }}
        {...dropHandlers}
      >
        {sectionList}

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

  const handleSyncClick = useCallback(() => {
    openSettings('account')
  }, [openSettings])

  const vaultPages = useSidebarVaultPages()

  const dock = (
    <>
      {authState.status === 'authenticated' ? (
        <SyncStatus onOpenSettings={handleSyncClick} iconOnly />
      ) : authState.status === 'checking' ? null : (
        <DockButton
          data-tour="sync-status"
          onClick={handleSyncClick}
          aria-label={tPhaseF('phaseF.componentsAppSidebar.syncDisabled')}
          title={tPhaseF('phaseF.componentsAppSidebar.syncDisabled2')}
        >
          <CloudOff aria-hidden="true" />
        </DockButton>
      )}
      <SidebarFeedbackButton />
      <SidebarSettingsButton />
    </>
  )

  return (
    <>
      <AppRail
        items={visibleNav}
        // Settings covers the workspace, so no page reads as the current one.
        isActive={isSettingsOpen ? () => false : isActiveItem}
        onNavClick={handleNavClick}
        onNavMiddleClick={handleNavMiddleClick}
        isModifierHeld={isModifierHeld}
        inboxCount={inboxCount}
        todayTasksCount={todayTasksCount}
        onOpenJournalSettings={() => openSettings('journal')}
        dock={dock}
        onReorder={handleRailReorder}
      />
      {/* The panel starts below the h-9 title row (WindowControls + WorkspaceDragStrip).
          With the workspace card beside it, it forms one surface: the panel owns the
          rounded top-start corner and its inline-end border divides it from the card. */}
      <Sidebar
        collapsible="offcanvas"
        {...props}
        className={cn(
          'top-9 h-[calc(100svh-2.25rem)] overflow-hidden rounded-ss-xl border-t border-s border-border group-data-[side=left]:border-border',
          props.className
        )}
      >
        <SidebarContent className="flex flex-col overflow-hidden gap-0">
          {isSettingsOpen && (
            <React.Suspense fallback={null}>
              <LazySettingsNav />
            </React.Suspense>
          )}
          {/* Hidden, not unmounted, while settings is open: the tree keeps its
              expansion and scroll position for the way back. */}
          <div className={isSettingsOpen ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
            <SidebarVaultPager pages={vaultPages}>
              <SidebarPanelHeader
                pages={vaultPages}
                onNewNote={() => void handleNewNote()}
                newItemActions={{
                  onNewNote: () => void handleNewNote(),
                  onJournal: () =>
                    openSidebarItem({
                      type: 'journal',
                      title: 'Journal',
                      path: '/journal'
                    }),
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
              <SidebarDrillDownContainer>{mainContent}</SidebarDrillDownContainer>
            </SidebarVaultPager>
          </div>
        </SidebarContent>
        <SidebarFooter className={cn('gap-2 p-2', isSettingsOpen && 'hidden')}>
          <GithubStarCard />
          <SidebarUpdateRow />
          <SidebarVaultDots pages={vaultPages} />
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
    </>
  )
}
