import { memo } from 'react'
import { cn } from '@/lib/utils'
import { Bell, Bookmark, MoreHorizontal, History, Monitor, GitGraph } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { NoteReminderButton } from './note-reminder-button'

interface NoteHeaderProps {
  noteId: string
  isBookmarked: boolean
  isLocalGraphOpen: boolean
  isLocalOnly: boolean
  isDeleted: boolean
  onToggleBookmark: () => void
  onToggleLocalGraph: () => void
  onToggleLocalOnly: () => void
  onOpenVersionHistory: () => void
  onOpenExport: () => void
}

export const NoteHeader = memo(function NoteHeader({
  noteId,
  isBookmarked,
  isLocalGraphOpen,
  isLocalOnly,
  isDeleted,
  onToggleBookmark,
  onToggleLocalGraph,
  onToggleLocalOnly,
  onOpenVersionHistory,
  onOpenExport
}: NoteHeaderProps) {
  return (
    <div className="flex items-center justify-end shrink-0 py-3.5 px-8 gap-3 border-b border-[var(--border)]">
      <div className="flex items-center gap-0.5">
        {/* Sync Badge */}
        <div className="flex items-center rounded-md py-1 px-2 gap-1 bg-accent-green/12">
          <div className="rounded-full bg-accent-green shrink-0 size-1.5" />
          <span className="text-[11px] text-accent-green font-sans font-medium leading-3.5">
            Synced
          </span>
        </div>

        <div className="w-px h-4 bg-[var(--border)] shrink-0 mx-2" />

        {/* Reminder */}
        <NoteReminderButton noteId={noteId} disabled={isDeleted} />

        {/* Bookmark */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 hover:bg-transparent"
          onClick={onToggleBookmark}
          disabled={isDeleted}
          title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
        >
          <Bookmark
            className={cn(
              'h-4 w-4',
              isBookmarked ? 'fill-accent-orange text-accent-orange' : 'text-muted-foreground'
            )}
          />
        </Button>

        {/* More Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 hover:bg-transparent"
              disabled={isDeleted}
            >
              <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onToggleLocalGraph}>
              <GitGraph className="mr-2 h-4 w-4" />
              {isLocalGraphOpen ? 'Hide local graph' : 'Show local graph'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenVersionHistory}>
              <History className="mr-2 h-4 w-4" />
              Version History
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenExport}>Export</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onToggleLocalOnly}>
              <Monitor className="mr-2 h-4 w-4" />
              {isLocalOnly ? 'Disable local only' : 'Set local only'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
})
