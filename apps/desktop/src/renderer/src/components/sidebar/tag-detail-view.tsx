/**
 * TagDetailView Component
 *
 * Displays notes for a specific tag in the sidebar drill-down view.
 * Features:
 * - Header with back button, tag name, and count
 * - Overflow menu for tag actions (edit, change color, delete)
 * - Pinned notes section
 * - All notes section with sorting options
 */

import * as React from 'react'
import { useCallback } from 'react'
import {
  ArrowLeft,
  MoreHorizontal,
  Pin,
  FileText,
  Trash2,
  Pencil,
  Palette,
  ArrowUpDown,
  Clock,
  Calendar,
  SortAsc
} from '@/lib/icons'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { useSidebarDrillDown } from '@/contexts/sidebar-drill-down'
import { useTagDetail, type TagSortBy } from '@/hooks/use-tag-detail'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { COLOR_NAMES, getTagColors } from '@/components/note/tags-row/tag-colors'
import { tagsService, type TagNoteItem } from '@/services/tags-service'
import type { SidebarItem } from '@/contexts/tabs/types'
import { createLogger } from '@/lib/logger'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { NoteIconDisplay } from '@/lib/render-note-icon'

const log = createLogger('Component:TagDetailView')

interface TagDetailViewProps {
  tag: string
  color: string
  className?: string
}

export function TagDetailView({ tag, color, className }: TagDetailViewProps): React.JSX.Element {
  const { goBack } = useSidebarDrillDown()
  const { openSidebarItem } = useSidebarNavigation()
  const {
    count,
    pinnedNotes,
    unpinnedNotes,
    color: resolvedColor,
    isLoading,
    error,
    sortBy,
    setSortBy,
    pinNote,
    unpinNote
  } = useTagDetail({ tag, fallbackColor: color })

  const tagColors = getTagColors(resolvedColor)

  // Handle note click - open in main area
  const handleNoteClick = useCallback(
    (note: TagNoteItem) => {
      const item: SidebarItem = {
        type: 'note',
        title: note.title,
        path: note.path,
        entityId: note.id,
        emoji: note.emoji
      }
      openSidebarItem(item)
    },
    [openSidebarItem]
  )

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-3 border-b">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={goBack}
          aria-label="Go back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{
                backgroundColor: tagColors.background,
                border: `1.5px solid ${tagColors.text}`
              }}
            />
            <span className="font-medium truncate">{tag}</span>
          </div>
          <p className="text-xs text-muted-foreground">{count} notes</p>
        </div>

        {/* Overflow menu */}
        <TagOverflowMenu tag={tag} color={resolvedColor} />
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        {isLoading ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            Loading notes...
          </div>
        ) : error ? (
          <div className="px-3 py-8 text-center text-sm text-destructive">{error}</div>
        ) : count === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            <p>No notes with this tag</p>
            <p className="mt-1 text-xs">Add this tag to a note to see it here</p>
          </div>
        ) : (
          <div className="py-2">
            {/* Pinned section */}
            {pinnedNotes.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <Pin className="h-3 w-3" />
                  PINNED
                </div>
                {pinnedNotes.map((note) => (
                  <NoteItem
                    key={note.id}
                    note={note}
                    isPinned
                    onClick={() => handleNoteClick(note)}
                    onPin={() => void pinNote(note.id)}
                    onUnpin={() => unpinNote(note.id)}
                  />
                ))}
                <Separator className="my-2" />
              </>
            )}

            {/* All notes section */}
            <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground flex items-center justify-between">
              <span>ALL NOTES</span>
              <SortDropdown sortBy={sortBy} onSortChange={setSortBy} />
            </div>
            {unpinnedNotes.map((note) => (
              <NoteItem
                key={note.id}
                note={note}
                isPinned={false}
                onClick={() => handleNoteClick(note)}
                onPin={() => pinNote(note.id)}
                onUnpin={() => unpinNote(note.id)}
              />
            ))}

            {/* Empty state for unpinned when all are pinned */}
            {unpinnedNotes.length === 0 && pinnedNotes.length > 0 && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                All notes are pinned
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

// ============================================================================
// Sub-components
// ============================================================================

interface NoteItemProps {
  note: TagNoteItem
  isPinned: boolean
  onClick: () => void
  onPin: () => void
  onUnpin: () => void
}

function NoteItem({ note, isPinned, onClick, onPin, onUnpin }: NoteItemProps): React.JSX.Element {
  // Format date
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))

    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return `${diffDays} days ago`
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const handlePinClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isPinned) {
      onUnpin()
    } else {
      onPin()
    }
  }

  return (
    <div
      className="group/noteitem px-3 py-2 hover:bg-accent/50 cursor-pointer relative"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
    >
      <div className="flex items-start gap-2">
        {/* Icon */}
        <div className="mt-0.5 shrink-0">
          {note.emoji ? (
            <NoteIconDisplay value={note.emoji} className="text-sm" />
          ) : (
            <FileText className="h-4 w-4 text-muted-foreground" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{note.title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{formatDate(note.modified)}</p>
        </div>

        {/* Pin button - always visible when pinned, only on hover when unpinned */}
        {isPinned ? (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handlePinClick}
                  className="shrink-0 mt-0.5 p-1 rounded-sm transition-colors hover:bg-accent text-primary"
                  aria-label="Unpin from tag"
                >
                  <Pin className="h-3.5 w-3.5 fill-current" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                Unpin
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handlePinClick}
                  className="shrink-0 mt-0.5 p-1 rounded-sm transition-all hover:bg-accent text-muted-foreground hover:text-foreground opacity-0 group-hover/noteitem:opacity-100"
                  aria-label="Pin to tag"
                >
                  <Pin className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                Pin
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </div>
  )
}

interface TagOverflowMenuProps {
  tag: string
  color: string
}

function TagOverflowMenu({ tag, color }: TagOverflowMenuProps): React.JSX.Element {
  // TODO: Implement rename and delete handlers
  const [isUpdatingColor, setIsUpdatingColor] = React.useState(false)

  const handleRename = () => {
    log.info('Rename tag:', tag)
    // TODO: Open rename dialog
  }

  const handleColorChange = async (newColor: string) => {
    if (newColor === color || isUpdatingColor) {
      return
    }

    setIsUpdatingColor(true)
    try {
      const result = await tagsService.updateTagColor({ tag, color: newColor })
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to update tag color')
      }
    } catch (error) {
      log.error('Failed to update tag color', error)
      toast.error(extractErrorMessage(error, 'Failed to update tag color'))
    } finally {
      setIsUpdatingColor(false)
    }
  }

  const handleDelete = () => {
    log.info('Delete tag:', tag)
    // TODO: Show confirmation and call tagsService.deleteTag
  }

  const colorOptions = COLOR_NAMES

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={handleRename}>
          <Pencil className="h-4 w-4 mr-2" />
          Edit tag name
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette className="h-4 w-4 mr-2" />
            Change color
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48 p-2">
            <div className="grid grid-cols-6 gap-1">
              {colorOptions.map((c) => {
                const colors = getTagColors(c)
                return (
                  <button
                    key={c}
                    className={cn(
                      'w-6 h-6 rounded-full border-2 transition-transform hover:scale-110',
                      c === color ? 'ring-2 ring-primary ring-offset-2' : ''
                    )}
                    style={{ backgroundColor: colors.background, borderColor: colors.text }}
                    onClick={() => handleColorChange(c)}
                    disabled={isUpdatingColor}
                    title={c}
                  />
                )
              })}
            </div>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="h-4 w-4 mr-2" />
          Delete tag
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface SortDropdownProps {
  sortBy: TagSortBy
  onSortChange: (sortBy: TagSortBy) => void
}

function SortDropdown({ sortBy, onSortChange }: SortDropdownProps): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-5 w-5">
          <ArrowUpDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuRadioGroup value={sortBy} onValueChange={(v) => onSortChange(v as TagSortBy)}>
          <DropdownMenuRadioItem value="modified">
            <Clock className="h-4 w-4 mr-2" />
            Recent
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="created">
            <Calendar className="h-4 w-4 mr-2" />
            Created
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="title">
            <SortAsc className="h-4 w-4 mr-2" />
            Alphabetical
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default TagDetailView
