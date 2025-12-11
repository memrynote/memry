import { useState } from 'react'
import { cn } from '@/lib/utils'
import { FileText, ChevronRight, MoreVertical, Folder } from 'lucide-react'
import { CardActionsMenu } from './CardActionsMenu'
import type { RelatedNote } from './types'
import { formatRelativeTime } from './types'

interface RelatedNoteCardProps {
  note: RelatedNote
  onNoteClick: (noteId: string) => void
  onAddReference: (noteId: string) => void
  onHideSuggestion: (noteId: string) => void
}

export function RelatedNoteCard({
  note,
  onNoteClick,
  onAddReference,
  onHideSuggestion
}: RelatedNoteCardProps) {
  const [isHovered, setIsHovered] = useState(false)

  const handleCopyLink = () => {
    // Copy note link to clipboard
    navigator.clipboard.writeText(`memry://note/${note.noteId}`)
  }

  // Determine score color based on similarity percentage
  const scoreColor = note.similarity >= 90
    ? 'text-green-600 dark:text-green-400'
    : note.similarity >= 75
      ? 'text-blue-600 dark:text-blue-400'
      : 'text-muted-foreground'

  return (
    <button
      onClick={() => onNoteClick(note.noteId)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        'w-full text-left p-3 rounded-lg',
        'bg-muted/30 hover:bg-muted/60',
        'border border-transparent hover:border-border/40',
        'transition-all duration-150',
        'group cursor-pointer relative'
      )}
      aria-label={`Related note: ${note.title}, ${note.similarity}% match`}
      role="listitem"
    >
      {/* Top row: Icon + Title + Percentage */}
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <FileText className="size-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium text-foreground truncate">
            {note.title}
          </span>
        </div>

        {/* Percentage in upper right corner */}
        <span className={cn('text-xs font-medium shrink-0', scoreColor)}>
          {note.similarity}%
        </span>
      </div>

      {/* Context Snippet */}
      <p className="text-xs text-muted-foreground line-clamp-2 mb-2 pl-6 italic">
        "{note.reason}"
      </p>

      {/* Bottom row: Metadata + Arrow */}
      <div className="flex items-center justify-between pl-6">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {note.folder && (
            <>
              <Folder className="h-3 w-3" />
              <span>{note.folder}</span>
              <span className="mx-1">•</span>
            </>
          )}
          <span>{formatRelativeTime(note.updatedAt)}</span>
        </div>

        <div className="flex items-center gap-1">
          {/* More actions menu */}
          <CardActionsMenu
            onOpenNote={() => onNoteClick(note.noteId)}
            onAddReference={() => onAddReference(note.noteId)}
            onCopyLink={handleCopyLink}
            onHide={() => onHideSuggestion(note.noteId)}
          >
            <button
              className={cn(
                'p-1 rounded hover:bg-muted transition-all duration-150',
                'text-muted-foreground hover:text-foreground',
                isHovered ? 'opacity-100' : 'opacity-0'
              )}
              onClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
              }}
              aria-label="More actions"
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </CardActionsMenu>

          {/* Arrow indicator */}
          <ChevronRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </div>
    </button>
  )
}
