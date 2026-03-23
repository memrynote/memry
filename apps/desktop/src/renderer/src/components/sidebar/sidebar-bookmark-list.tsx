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
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useBookmarks, type BookmarkWithItem } from '@/hooks/use-bookmarks'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { BookmarkItemTypes } from '@memry/contracts/bookmarks-api'
import type { SidebarItem, TabType } from '@/contexts/tabs/types'

interface SidebarBookmarkListProps {
  /** Maximum number of bookmarks to show before "Show more" */
  maxVisible?: number
  /** Callback when a bookmark is clicked */
  onBookmarkClick?: (bookmark: BookmarkWithItem) => void
  /** Custom class name */
  className?: string
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
  [BookmarkItemTypes.TASK]: 'tasks'
}

export function SidebarBookmarkList({
  maxVisible = 8,
  onBookmarkClick,
  className
}: SidebarBookmarkListProps): React.JSX.Element {
  const { bookmarks, isLoading, error, removeBookmark } = useBookmarks({
    sortBy: 'position',
    sortOrder: 'asc'
  })
  const { isActiveItem } = useSidebarNavigation()
  const [showAll, setShowAll] = React.useState(false)

  // Filter to only existing items
  const validBookmarks = React.useMemo(() => {
    return bookmarks.filter((b) => b.itemExists)
  }, [bookmarks])

  const visibleBookmarks = showAll ? validBookmarks : validBookmarks.slice(0, maxVisible)
  const hasMore = validBookmarks.length > maxVisible

  const handleBookmarkClick = (bookmark: BookmarkWithItem) => (e: React.MouseEvent) => {
    e.preventDefault()
    onBookmarkClick?.(bookmark)
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
          <span>Loading bookmarks...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <span className="text-xs text-destructive">Failed to load bookmarks</span>
      </div>
    )
  }

  if (validBookmarks.length === 0) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <span className="text-xs text-muted-foreground">No bookmarks yet</span>
      </div>
    )
  }

  return (
    <div className={className}>
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
          <SidebarMenuItem key={bookmark.id}>
            <SidebarMenuButton
              tooltip={title}
              onClick={handleBookmarkClick(bookmark)}
              isActive={isActiveItem(sidebarItem)}
              className="group pr-8"
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

              <span className="flex-1 truncate text-[13px] text-sidebar-text-folder font-medium">
                {title}
              </span>
            </SidebarMenuButton>

            {/* Actions dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuAction
                  className="opacity-0 group-hover/menu-item:opacity-100 transition-opacity"
                  showOnHover
                >
                  <MoreHorizontal className="size-4" />
                  <span className="sr-only">More options</span>
                </SidebarMenuAction>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem
                  onClick={handleRemoveBookmark(bookmark)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="size-4 mr-2" />
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        )
      })}

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
