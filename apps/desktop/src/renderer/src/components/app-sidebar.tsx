'use client'

import * as React from 'react'
import { useMemo, useState, useCallback, useRef } from 'react'
import {
  Calendar2,
  CloudOff,
  ChevronsDown,
  ChevronsUp,
  FilePlus,
  FolderPlus,
  Plus,
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
import { SidebarBookmarkList } from '@/components/sidebar/sidebar-bookmark-list'
import { SidebarDrillDownContainer } from '@/components/sidebar/sidebar-drill-down-container'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSelectedFolder } from '@/contexts/selected-folder-context'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { useTabActions } from '@/contexts/tabs'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { notesService } from '@/services/notes-service'
import { useSidebarDrillDown } from '@/contexts/sidebar-drill-down'
import { useAuth } from '@/contexts/auth-context'
import { SyncStatus } from '@/components/sync/sync-status'
import { useInboxList } from '@/hooks/use-inbox'
import type { SidebarItem, TabType } from '@/contexts/tabs/types'
import type { AppPage } from '@/App'
import type { BookmarkWithItem } from '@/hooks/use-bookmarks'
import { BookmarkItemTypes } from '@memry/contracts/bookmarks-api'
import { getAllSupportedExtensions } from '@memry/shared/file-types'
import { createLogger } from '@/lib/logger'
import { useFileDrop } from '@/hooks/use-file-drop'
import { extractErrorMessage } from '@/lib/ipc-error'

const log = createLogger('Component:AppSidebar')

const mainNav: {
  title: string
  page: AppPage
  icon: typeof SidebarInbox
}[] = [
  { title: 'Inbox', page: 'inbox', icon: SidebarInbox },
  { title: 'Journal', page: 'journal', icon: SidebarJournal },
  { title: 'Calendar', page: 'calendar', icon: Calendar2 },
  { title: 'Tasks', page: 'tasks', icon: SidebarTasks }
]

function SidebarHeaderContent() {
  // Empty h-9 spacer to reserve room for the viewport-fixed WindowControls
  // overlay (see App.tsx). Sidebar content starts below the chrome row.
  return <SidebarHeader className="h-9 shrink-0" />
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
function AppSidebarInner({ currentPage, viewCounts, ...props }: AppSidebarProps) {
  const [tagsActions, setTagsActions] = useState<React.ReactNode>(null)
  const notesActionsRef = useRef<NotesTreeActions | null>(null)
  const [foldersExpanded, setFoldersExpanded] = useState(false)
  const sidebarScrollRef = useRef<HTMLDivElement>(null)
  const targetFolderRef = useRef('')

  const handleFileDrop = useCallback(async (paths: string[]) => {
    try {
      const result = await notesService.importFiles(paths, targetFolderRef.current)

      if (result.imported > 0) {
        toast.success(`Imported ${result.imported} file${result.imported > 1 ? 's' : ''}`)
      }
      if (result.failed > 0) {
        toast.error(`Failed to import ${result.failed} file${result.failed > 1 ? 's' : ''}`, {
          description: result.errors?.join('\n')
        })
      }
    } catch (err) {
      log.error('Failed to import dropped files', err)
      toast.error(extractErrorMessage(err, 'Failed to import files'))
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

  const { isDraggingFiles, dropHandlers } = useFileDrop({ onDrop: handleFileDrop })

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

  // Tab actions for opening new notes (stable reference, won't cause re-renders)
  const { openTab } = useTabActions()

  // Drill-down context for tag navigation
  const { openTag } = useSidebarDrillDown()

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
      }
    } catch (error) {
      log.error('Failed to create new note', error)
      toast.error(extractErrorMessage(error, 'Failed to create note'))
    }
  }, [openTab, generalSettings.createInSelectedFolder])

  const handleNavClick = (page: AppPage) => (e: React.MouseEvent) => {
    e.preventDefault()

    // Map page to tab type and title
    const pageToTabType: Record<AppPage, TabType> = {
      inbox: 'inbox',
      calendar: 'calendar',
      journal: 'journal',
      tasks: 'tasks',
      graph: 'graph'
    }
    const pageToTitle: Record<AppPage, string> = {
      inbox: 'Inbox',
      calendar: 'Calendar',
      journal: 'Journal',
      tasks: 'Tasks',
      graph: 'Graph'
    }

    // Open as tab in active pane
    const item: SidebarItem = {
      type: pageToTabType[page],
      title: pageToTitle[page],
      path: `/${page}`
    }
    openSidebarItem(item)
  }

  // Handle tag click - open tag drill-down view
  const handleTagClick = useCallback(
    (tag: string, color: string) => {
      openTag(tag, color)
    },
    [openTag]
  )

  // Handle bookmark click - navigate to bookmarked item
  const handleBookmarkClick = useCallback(
    (bookmark: BookmarkWithItem) => {
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
    [openSidebarItem]
  )

  // Main sidebar content (shown when not drilling down)
  const mainContent = (
    <>
      {/* Separator between nav and collections */}
      <div className="h-px bg-sidebar-border shrink-0 mx-3 my-2 group-data-[collapsible=icon]:mx-1.5" />

      {/* SCROLLABLE SECTION - Collections, Bookmarks, Tags — entire area is drop target */}
      <div
        ref={sidebarScrollRef}
        className="relative flex-1 min-h-0 overflow-y-auto scrollbar-thin group-data-[collapsible=icon]:overflow-hidden"
        {...dropHandlers}
      >
        {/* COLLECTIONS Section */}
        <SidebarSection
          id="collections"
          label="Collections"
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
                    aria-label="New note"
                  >
                    <FilePlus className="size-3.5 text-sidebar-muted hover:text-sidebar-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  New note
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => notesActionsRef.current?.createFolder()}
                    className="p-0.5 rounded cursor-pointer hover:bg-sidebar-accent transition-colors"
                    aria-label="New folder"
                  >
                    <FolderPlus className="size-3.5 text-sidebar-muted hover:text-sidebar-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  New folder
                </TooltipContent>
              </Tooltip>
            </>
          }
        >
          <NotesTree
            ref={notesActionsRef}
            onTargetFolderChange={handleTargetFolderChange}
            scrollContainerRef={sidebarScrollRef as React.RefObject<HTMLElement>}
          />
        </SidebarSection>

        {/* BOOKMARKS Section */}
        <SidebarSection id="bookmarks" label="Bookmarks" defaultExpanded={false}>
          <SidebarBookmarkList maxVisible={6} onBookmarkClick={handleBookmarkClick} />
        </SidebarSection>

        {/* TAGS Section */}
        <SidebarSection id="tags" label="Tags" defaultExpanded={false} actions={tagsActions}>
          <SidebarTagList
            maxVisible={6}
            onTagClick={handleTagClick}
            onActionsReady={setTagsActions}
          />
        </SidebarSection>

        {/* Drop overlay — covers entire scrollable area, blocks pointer events when visible */}
        <div
          className={cn(
            'absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm transition-opacity duration-150',
            isDraggingFiles ? 'opacity-100' : 'opacity-0 invisible pointer-events-none'
          )}
        >
          <div className="flex flex-col items-center gap-2 rounded-md border-2 border-dashed border-primary/50 px-6 py-4">
            <Upload className="size-6 text-primary" />
            <span className="text-sm font-medium">Drop files to import</span>
            <span className="text-xs text-muted-foreground">
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

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeaderContent />
      <SidebarContent className="flex flex-col overflow-hidden gap-0">
        {/* Quick Action: New — persistent, stays visible during drill-down */}
        <div className="shrink-0 flex items-center px-3 pt-2 pb-0 group-data-[collapsible=icon]:hidden">
          <button
            type="button"
            onClick={handleNewNote}
            className="flex flex-1 items-center justify-center gap-2 h-[30px] rounded-[5px] bg-sidebar-surface hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
            title="New note (⌘N)"
          >
            <Plus className="size-[15px] text-muted-foreground/70" />
            <span className="text-[13px] text-muted-foreground/70 font-normal">New</span>
          </button>
        </div>
        <SidebarNav
          items={mainNav}
          isActive={isActiveItem}
          onNavClick={handleNavClick}
          inboxCount={inboxCount}
          todayTasksCount={todayTasksCount}
        />
        <SidebarDrillDownContainer>{mainContent}</SidebarDrillDownContainer>
      </SidebarContent>
      <SidebarFooter className="gap-0 p-2">
        <div className="flex items-center gap-1">
          {authState.status === 'authenticated' ? (
            <div className="shrink-0 w-7 [&>button]:w-7 [&>button]:justify-center">
              <SyncStatus onOpenSettings={handleSyncClick} iconOnly />
            </div>
          ) : authState.status === 'checking' ? null : (
            <button
              type="button"
              onClick={handleSyncClick}
              aria-label="Sync disabled"
              title="Sync disabled"
              className="shrink-0 size-7 rounded flex items-center justify-center hover:bg-sidebar-accent text-muted-foreground transition-colors"
            >
              <CloudOff className="size-4" />
            </button>
          )}
          <div className="flex-1 min-w-0">
            <VaultSwitcher />
          </div>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
