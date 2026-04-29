import { getI18n } from 'react-i18next'
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
import { useCallback, useEffect, useState } from 'react'
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
import { tagsService, onTagRenamed, onTagDeleted, type TagNoteItem } from '@/services/tags-service'
import type { SidebarItem } from '@/contexts/tabs/types'
import { createLogger } from '@/lib/logger'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { TagRenameDialog } from './tag-rename-dialog'
import { TagDeleteDialog } from './tag-delete-dialog'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('Component:TagDetailView')

interface TagDetailViewProps {
  tag: string
  color: string
  className?: string
}

export function TagDetailView({ tag, color, className }: TagDetailViewProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
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
    unpinNote,
    refresh
  } = useTagDetail({ tag, fallbackColor: color })

  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

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

  const handleRenameSubmit = useCallback(
    async (newName: string) => {
      const tSettings = getI18n().getFixedT(null, 'settings')
      try {
        const result = await tagsService.renameTag({ oldName: tag, newName })
        if (!result.success) {
          throw new Error(result.error ?? tSettings('tags.toasts.renameFailed'))
        }
        toast.success(tSettings('tags.toasts.renamed', { oldName: tag, newName }))
        goBack()
      } catch (err) {
        log.error('Failed to rename tag', err)
        const message = extractErrorMessage(err, tSettings('tags.toasts.renameFailed'))
        toast.error(message)
        throw err instanceof Error ? err : new Error(message)
      }
    },
    [goBack, tag]
  )

  const handleDeleteConfirm = useCallback(async () => {
    const tSettings = getI18n().getFixedT(null, 'settings')
    try {
      const result = await tagsService.deleteTag(tag)
      if (!result.success) {
        throw new Error(result.error ?? tSettings('tags.toasts.deleteFailed'))
      }
      toast.success(tSettings('tags.toasts.deleted', { name: tag, count }))
      goBack()
    } catch (err) {
      log.error('Failed to delete tag', err)
      toast.error(extractErrorMessage(err, tSettings('tags.toasts.deleteFailed')))
    }
  }, [goBack, tag, count])

  useEffect(() => {
    const unsubscribeRenamed = onTagRenamed((event) => {
      if (event.oldName.toLowerCase() === tag.toLowerCase()) {
        goBack()
        return
      }
      void refresh()
    })
    const unsubscribeDeleted = onTagDeleted((event) => {
      if (event.tag.toLowerCase() === tag.toLowerCase()) {
        goBack()
      }
    })
    return () => {
      unsubscribeRenamed()
      unsubscribeDeleted()
    }
  }, [goBack, refresh, tag])

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-3 border-b">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={goBack}
          aria-label={tPhaseF('phaseF.componentsSidebarTagDetailView.goBack')}
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
            <span className="font-medium truncate">
              {tag.includes('/') ? (
                <span className="flex items-center gap-0.5">
                  {tag.split('/').map((segment, i, arr) => (
                    <span key={i} className="flex items-center gap-0.5">
                      {i > 0 && <span className="text-muted-foreground/40 text-xs">/</span>}
                      <span className={i < arr.length - 1 ? 'text-muted-foreground' : ''}>
                        {segment}
                      </span>
                    </span>
                  ))}
                </span>
              ) : (
                tag
              )}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {count} {tPhaseF('phaseF.componentsSidebarTagDetailView.notes')}
          </p>
        </div>

        {/* Overflow menu */}
        <TagOverflowMenu
          tag={tag}
          color={resolvedColor}
          onRequestRename={() => setRenameOpen(true)}
          onRequestDelete={() => setDeleteOpen(true)}
        />
      </div>

      <TagRenameDialog
        tag={tag}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        onSubmit={handleRenameSubmit}
      />
      <TagDeleteDialog
        tag={tag}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDeleteConfirm}
      />

      {/* Content */}
      <ScrollArea className="flex-1">
        {isLoading ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            {tPhaseF('phaseF.componentsSidebarTagDetailView.loadingNotes')}
          </div>
        ) : error ? (
          <div className="px-3 py-8 text-center text-sm text-destructive">{error}</div>
        ) : count === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            <p>{tPhaseF('phaseF.componentsSidebarTagDetailView.noNotesWithThisTag')}</p>
            <p className="mt-1 text-xs">
              {tPhaseF('phaseF.componentsSidebarTagDetailView.addThisTagToANoteToSeeItHere')}
            </p>
          </div>
        ) : (
          <div className="py-2">
            {/* Pinned section */}
            {pinnedNotes.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <Pin className="h-3 w-3" />

                  {tPhaseF('phaseF.componentsSidebarTagDetailView.pinned')}
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
              <span>{tPhaseF('phaseF.componentsSidebarTagDetailView.allNotes')}</span>
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
                {tPhaseF('phaseF.componentsSidebarTagDetailView.allNotesArePinned')}
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
  const { t: tPhaseF } = useT('notes')
  const { t: tCommon } = useT('common')
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))

    if (diffDays === 0) return tCommon('dateRelative.today')
    if (diffDays === 1) return tCommon('dateRelative.yesterday')
    if (diffDays < 7) return tCommon('dateRelative.daysAgo', { count: diffDays })
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
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
                  aria-label={tPhaseF('phaseF.componentsSidebarTagDetailView.unpinFromTag')}
                >
                  <Pin className="h-3.5 w-3.5 fill-current" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                {tPhaseF('phaseF.componentsSidebarTagDetailView.unpin')}
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
                  aria-label={tPhaseF('phaseF.componentsSidebarTagDetailView.pinToTag')}
                >
                  <Pin className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                {tPhaseF('phaseF.componentsSidebarTagDetailView.pin')}
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
  onRequestRename: () => void
  onRequestDelete: () => void
}

function TagOverflowMenu({
  tag,
  color,
  onRequestRename,
  onRequestDelete
}: TagOverflowMenuProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  const [isUpdatingColor, setIsUpdatingColor] = React.useState(false)

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
      toast.error(
        extractErrorMessage(
          error,
          getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToUpdateTagColor')
        )
      )
    } finally {
      setIsUpdatingColor(false)
    }
  }

  const colorOptions = COLOR_NAMES

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={tPhaseF('phaseF.componentsSidebarTagDetailView.tagActions')}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={onRequestRename}>
          <Pencil className="h-4 w-4 mr-2" />

          {tPhaseF('phaseF.componentsSidebarTagDetailView.editTagName')}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette className="h-4 w-4 mr-2" />

            {tPhaseF('phaseF.componentsSidebarTagDetailView.changeColor')}
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
          onClick={onRequestDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="h-4 w-4 mr-2" />

          {tPhaseF('phaseF.componentsSidebarTagDetailView.deleteTag')}
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
  const { t: tPhaseF } = useT('notes')
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

            {tPhaseF('phaseF.componentsSidebarTagDetailView.recent')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="created">
            <Calendar className="h-4 w-4 mr-2" />

            {tPhaseF('phaseF.componentsSidebarTagDetailView.created')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="title">
            <SortAsc className="h-4 w-4 mr-2" />

            {tPhaseF('phaseF.componentsSidebarTagDetailView.alphabetical')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default TagDetailView
