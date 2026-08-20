/**
 * SidebarBookmarkList Component
 * Displays a list of bookmarked items in the sidebar.
 * Clicking a bookmark navigates directly to that item.
 */

import * as React from 'react'
import {
  Star,
  FileText,
  Calendar,
  CheckSquare,
  Image,
  FileAudio,
  File,
  Folder,
  Hash,
  MoreHorizontal,
  Trash2
} from '@/lib/icons'

import { cn } from '@/lib/utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { SidebarMenuItem, SidebarMenuButton, SidebarMenuAction } from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useDndMonitor } from '@dnd-kit/core'
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { SidebarSortMode } from '@memry/contracts/sidebar-sort'
import { SortableBookmarkItem } from '@/components/sidebar/sortable-bookmark-item'
import { BOOKMARK_SORT_DRAG_TYPE } from '@/components/sidebar/sidebar-drag-types'
import { compareListItems, isReorderable } from '@/components/sidebar/sidebar-list-sort'
import { OpenTargetMenuItems } from '@/components/sidebar/open-target-menu-items'
import { useOpenTarget } from '@/hooks/use-open-target'
import { createTabFromSidebarItem } from '@/contexts/tabs/helpers'
import { useBookmarks, type BookmarkWithItem } from '@/hooks/use-bookmarks'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { BookmarkItemTypes } from '@memry/contracts/bookmarks-api'
import type { SidebarItem, TabType } from '@/contexts/tabs/types'
import { useT } from '@memry/i18n/renderer'

interface SidebarBookmarkListProps {
  /** Maximum number of bookmarks to show before "Show more" */
  maxVisible?: number
  /** Callback when a bookmark is clicked */
  onBookmarkClick?: (bookmark: BookmarkWithItem) => void
  /** Custom class name */
  className?: string
  /** Which order to show them in; only 'manual' allows drag-to-reorder. */
  sortMode?: SidebarSortMode
}

/**
 * Get icon for bookmark item type
 */
function getBookmarkIcon(itemType: string) {
  switch (itemType) {
    case BookmarkItemTypes.NOTE:
      return FileText
    case BookmarkItemTypes.JOURNAL:
      return Calendar
    case BookmarkItemTypes.TASK:
      return CheckSquare
    case BookmarkItemTypes.FOLDER:
      return Folder
    case BookmarkItemTypes.TAG:
      return Hash
    case BookmarkItemTypes.IMAGE:
      return Image
    case BookmarkItemTypes.AUDIO:
      return FileAudio
    default:
      return File
  }
}

/**
 * Get color class for bookmark item type
 */
function getBookmarkIconColor(_itemType: string): string {
  return 'text-sidebar-foreground'
}

// Map bookmark item type to tab type
const bookmarkItemTypeToTabType: Record<string, TabType> = {
  [BookmarkItemTypes.NOTE]: 'note',
  [BookmarkItemTypes.JOURNAL]: 'journal',
  [BookmarkItemTypes.TASK]: 'tasks',
  [BookmarkItemTypes.FOLDER]: 'folder'
}

export function SidebarBookmarkList({
  maxVisible = 8,
  onBookmarkClick,
  className,
  sortMode = 'manual'
}: SidebarBookmarkListProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  const { bookmarks, isLoading, error, removeBookmark, reorderBookmarks } = useBookmarks({
    sortBy: 'position',
    sortOrder: 'asc'
  })
  const { isActiveItem } = useSidebarNavigation()
  const [showAll, setShowAll] = React.useState(false)

  const reorderable = isReorderable(sortMode)

  // Filter to only existing items
  const validBookmarks = React.useMemo(() => {
    return bookmarks
      .filter((b) => b.itemExists)
      .map((bookmark) => ({
        bookmark,
        name: bookmark.itemTitle ?? '',
        position: bookmark.position,
        created: Date.parse(bookmark.createdAt)
      }))
      .sort(compareListItems(sortMode))
      .map((entry) => entry.bookmark)
  }, [bookmarks, sortMode])

  // REQUIRES a surrounding DndContext — useDndMonitor throws without one. The
  // app's DragProvider wraps the whole tree, so the sidebar's single call site
  // always satisfies this; any new call site (or test) must provide one too.
  // Ids here are bookmark ids; a drag that started anywhere else is ignored.
  useDndMonitor({
    onDragEnd: ({ active, over }) => {
      if (!reorderable || !over || active.id === over.id) return
      if (active.data.current?.type !== BOOKMARK_SORT_DRAG_TYPE) return
      const from = validBookmarks.findIndex((b) => b.id === active.id)
      const to = validBookmarks.findIndex((b) => b.id === over.id)
      if (from === -1 || to === -1) return
      const next = arrayMove(validBookmarks, from, to)
      void reorderBookmarks(next.map((b) => b.id))
    }
  })

  const visibleBookmarks = showAll ? validBookmarks : validBookmarks.slice(0, maxVisible)
  const hasMore = validBookmarks.length > maxVisible

  const handleBookmarkClick = (bookmark: BookmarkWithItem) => (e: React.MouseEvent) => {
    e.preventDefault()
    onBookmarkClick?.(bookmark)
  }

  // Middle-click opens the bookmarked item in a background tab — the same tab
  // the row's "Open in New Tab" menu command builds. Read on mousedown because
  // a middle click never produces `click`.
  const { openInNewTab } = useOpenTarget()
  const handleBookmarkMiddleClick = (item: SidebarItem) => (e: React.MouseEvent) => {
    if (e.button !== 1) return
    e.preventDefault()
    openInNewTab(createTabFromSidebarItem(item), { background: true })
  }

  const handleRemoveBookmark = (bookmark: BookmarkWithItem) => async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    await removeBookmark(bookmark.id)
  }

  if (isLoading) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Star className="size-3 animate-pulse" />
          <span>{tPhaseF('phaseF.componentsSidebarSidebarBookmarkList.loadingBookmarks')}</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <span className="text-xs text-destructive">
          {tPhaseF('phaseF.componentsSidebarSidebarBookmarkList.failedToLoadBookmarks')}
        </span>
      </div>
    )
  }

  if (validBookmarks.length === 0) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <span className="text-xs text-muted-foreground">
          {tPhaseF('phaseF.componentsSidebarSidebarBookmarkList.noBookmarksYet')}
        </span>
      </div>
    )
  }

  return (
    <div className={className}>
      <SortableContext
        items={visibleBookmarks.map((b) => b.id)}
        strategy={verticalListSortingStrategy}
      >
        {visibleBookmarks.map((bookmark) => {
          const Icon = getBookmarkIcon(bookmark.itemType)
          const iconColor = getBookmarkIconColor(bookmark.itemType)
          const title = bookmark.itemTitle || 'Untitled'
          const emoji = bookmark.itemMeta?.emoji

          // Create SidebarItem to check active state from tab system
          const tabType = bookmarkItemTypeToTabType[bookmark.itemType] || 'note'
          const sidebarItem: SidebarItem = {
            type: tabType,
            title,
            path: bookmark.itemMeta?.path || `/${bookmark.itemType}/${bookmark.itemId}`,
            entityId: bookmark.itemId
          }

          return (
            <SortableBookmarkItem key={bookmark.id} id={bookmark.id} disabled={!reorderable}>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <SidebarMenuButton
                    tooltip={title}
                    onClick={handleBookmarkClick(bookmark)}
                    onMouseDown={handleBookmarkMiddleClick(sidebarItem)}
                    isActive={isActiveItem(sidebarItem)}
                    className="group pe-8"
                  >
                    {/* Icon or emoji */}
                    {emoji ? (
                      <NoteIconDisplay
                        value={emoji}
                        className="size-4 flex items-center justify-center text-sm shrink-0"
                      />
                    ) : (
                      <Icon className={cn('size-4 shrink-0', iconColor)} aria-hidden="true" />
                    )}

                    <span className="sidebar-label-fade flex-1 text-[13px] text-sidebar-text-folder font-medium">
                      {title}
                    </span>
                  </SidebarMenuButton>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  <OpenTargetMenuItems tab={createTabFromSidebarItem(sidebarItem)} />
                </ContextMenuContent>
              </ContextMenu>

              {/* Actions dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuAction
                    className="opacity-0 group-hover/menu-item:opacity-100 transition-opacity"
                    showOnHover
                  >
                    <MoreHorizontal className="size-4" />
                    <span className="sr-only">
                      {tPhaseF('phaseF.componentsSidebarSidebarBookmarkList.moreOptions')}
                    </span>
                  </SidebarMenuAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <OpenTargetMenuItems
                    tab={createTabFromSidebarItem(sidebarItem)}
                    component={DropdownMenuItem}
                  />
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(...args) => void handleRemoveBookmark(bookmark)(...args)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="size-4 me-2" />

                    {tPhaseF('phaseF.componentsSidebarSidebarBookmarkList.remove')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SortableBookmarkItem>
          )
        })}
      </SortableContext>

      {/* Show more/less button */}
      {hasMore && (
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={() => setShowAll(!showAll)}
            className="text-muted-foreground hover:text-foreground"
          >
            <Star className="size-3.5 opacity-50" />
            <span className="text-xs">
              {showAll ? 'Show less' : `+${validBookmarks.length - maxVisible} more`}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
    </div>
  )
}

export default SidebarBookmarkList
