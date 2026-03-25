'use client'

import * as React from 'react'
import { useMemo, useState, useCallback, useRef } from 'react'
import { CloudOff, FilePlus, FolderPlus, Plus, Search, Upload } from '@/lib/icons'
import {
  SidebarInbox,
  SidebarHome,
  SidebarJournal,
  SidebarTasks,
  SidebarGraph
} from '@/lib/icons/sidebar-nav-icons'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { VaultSwitcher } from '@/components/vault-switcher'
import { TrafficLights } from '@/components/traffic-lights'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar
} from '@/components/ui/sidebar'
import { SidebarSection } from '@/components/sidebar-section'
import { NotesTree } from '@/components/notes-tree'
import { SidebarTagList } from '@/components/sidebar/sidebar-tag-list'
import { SidebarBookmarkList } from '@/components/sidebar/sidebar-bookmark-list'
import { SidebarDrillDownContainer } from '@/components/sidebar/sidebar-drill-down-container'
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
  shortcut?: string
}[] = [
  { title: 'Inbox', page: 'inbox', icon: SidebarInbox },
  { title: 'Home', page: 'home', icon: SidebarHome },
  { title: 'Journal', page: 'journal', icon: SidebarJournal, shortcut: '⌘J' },
  { title: 'Tasks', page: 'tasks', icon: SidebarTasks },
  { title: 'Graph', page: 'graph', icon: SidebarGraph, shortcut: '⌘G' }
]

function SidebarHeaderContent() {
  const { state } = useSidebar()
  const isCollapsed = state === 'collapsed'

  return (
    <SidebarHeader className="pt-3 pb-0 px-2 gap-0">
      <div
        className={cn(
          'drag-region flex items-center shrink-0',
          isCollapsed ? 'justify-center' : 'px-1'
        )}
      >
        <TrafficLights compact={isCollapsed} />
        <div className="group-data-[collapsible=icon]:hidden">
          <VaultSwitcher />
        </div>
      </div>
    </SidebarHeader>
  )
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
  const notesActionsRef = useRef<{ createNote: () => void; createFolder: () => void } | null>(null)
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

  const handleTargetFolderChange = useCallback((folder: string) => {
    targetFolderRef.current = folder
  }, [])

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

  // Handle creating a new note
  const handleNewNote = useCallback(async () => {
    try {
      const result = await notesService.create({
        title: 'Untitled Note',
        content: ''
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
  }, [openTab])

  const handleNavClick = (page: AppPage) => (e: React.MouseEvent) => {
    e.preventDefault()

    // Map page to tab type and title
    const pageToTabType: Record<AppPage, TabType> = {
      inbox: 'inbox',
      home: 'home',
      journal: 'journal',
      tasks: 'tasks',
      graph: 'graph'
    }
    const pageToTitle: Record<AppPage, string> = {
      inbox: 'Inbox',
      home: 'Home',
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
      {/* FIXED SECTION - Quick Actions & Main Nav (doesn't scroll) */}
      <div className="flex-shrink-0">
        {/* Quick Actions: Search & New (side by side) */}
        <div className="flex items-center gap-1.5 px-3 pt-1 pb-0 group-data-[collapsible=icon]:px-1.5 group-data-[collapsible=icon]:justify-center">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('memry:open-search'))}
            className="flex flex-1 items-center gap-2 rounded-[5px] bg-sidebar-surface py-[6px] px-2.5 cursor-pointer hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
          >
            <Search className="size-[14px] text-muted-foreground/70 shrink-0" />
            <span className="text-[13px] text-muted-foreground/70 font-normal group-data-[collapsible=icon]:hidden">
              Search
            </span>
            <span className="ml-auto font-mono text-[9px] text-sidebar-muted/50 bg-sidebar-border rounded-[3px] px-1 py-0.5 group-data-[collapsible=icon]:hidden">
              ⌘K
            </span>
          </button>
          <button
            type="button"
            onClick={handleNewNote}
            className="flex items-center justify-center size-[30px] rounded-[5px] bg-sidebar-surface hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors cursor-pointer shrink-0 group-data-[collapsible=icon]:hidden"
            title="New note (⌘N)"
          >
            <Plus className="size-[15px] text-muted-foreground/70" />
          </button>
        </div>

        {/* Main Navigation: Inbox, Home, Journal, Tasks */}
        <SidebarGroup className="px-2 pt-1 pb-0">
          <SidebarMenu className="gap-px">
            {mainNav.map((item) => {
              const sidebarItem: SidebarItem = {
                type: item.page as TabType,
                title: item.title,
                path: `/${item.page}`
              }
              const active = isActiveItem(sidebarItem)
              return (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    tooltip={item.title}
                    isActive={active}
                    onClick={handleNavClick(item.page)}
                    className={cn(
                      'relative rounded-[5px] h-7 px-2.5 gap-2.5',
                      active && 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                    )}
                  >
                    {active && (
                      <div className="absolute left-0 inset-y-1.5 w-0.75 rounded-r-xs bg-tint" />
                    )}
                    <item.icon
                      className={cn(
                        'size-[15px] text-sidebar-foreground',
                        active ? 'opacity-85' : 'opacity-45'
                      )}
                    />
                    <span
                      className={cn(
                        'text-[13px] leading-4 font-medium',
                        active ? 'text-sidebar-accent-foreground' : 'text-sidebar-foreground'
                      )}
                    >
                      {item.title}
                    </span>
                    {item.page === 'inbox' && inboxCount > 0 && (
                      <span className="ml-auto text-sidebar-muted font-medium text-[11px]">
                        {inboxCount}
                      </span>
                    )}
                    {item.page === 'tasks' && todayTasksCount > 0 && (
                      <span className="ml-auto text-sidebar-muted font-medium text-[11px]">
                        {todayTasksCount}
                      </span>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
        </SidebarGroup>
      </div>

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
              <button
                type="button"
                onClick={() => notesActionsRef.current?.createNote()}
                className="p-0.5 rounded cursor-pointer hover:bg-sidebar-accent transition-colors"
                aria-label="New note"
              >
                <FilePlus className="size-3.5 text-sidebar-muted hover:text-sidebar-foreground" />
              </button>
              <button
                type="button"
                onClick={() => notesActionsRef.current?.createFolder()}
                className="p-0.5 rounded cursor-pointer hover:bg-sidebar-accent transition-colors"
                aria-label="New folder"
              >
                <FolderPlus className="size-3.5 text-sidebar-muted hover:text-sidebar-foreground" />
              </button>
            </>
          }
        >
          <NotesTree
            onActionsReady={(actions) => {
              notesActionsRef.current = actions
            }}
            onTargetFolderChange={handleTargetFolderChange}
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
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeaderContent />
      <SidebarContent className="flex flex-col overflow-hidden gap-0">
        <SidebarDrillDownContainer>{mainContent}</SidebarDrillDownContainer>
      </SidebarContent>
      <SidebarFooter className="gap-0">
        <SidebarMenu>
          <SidebarMenuItem>
            {authState.status === 'authenticated' ? (
              <SyncStatus onOpenSettings={handleSyncClick} iconOnly />
            ) : authState.status === 'checking' ? null : (
              <SidebarMenuButton tooltip="Sync disabled" onClick={handleSyncClick}>
                <CloudOff className="size-4 text-muted-foreground" />
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
