import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ChevronRight, MoreVertical, Folder } from 'lucide-react'
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

  return (
    <div
      onClick={() => onNoteClick(note.noteId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onNoteClick(note.noteId)
        }
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        'w-full text-left p-3.5 rounded-lg',
        'bg-sidebar-accent/20 hover:bg-sidebar-accent/40',
        'border border-sidebar-border/20 hover:border-sidebar-border/40',
        'transition-all duration-200',
        'group cursor-pointer relative',
        'hover:shadow-sm hover:translate-x-0.5',
        'focus:outline-none focus:ring-2 focus:ring-sidebar-ring focus:ring-offset-1'
      )}
      aria-label={`Related note: ${note.title}, ${note.similarity}% match`}
      role="listitem"
      tabIndex={0}
    >
      {/* Top row: Icon + Title + Percentage */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          {/* Icon with subtle background */}
          <div className="flex items-center justify-center size-6 rounded-md bg-sidebar-accent/40 shrink-0">
            <span className="text-sm">{note.icon || '📄'}</span>
          </div>
          <span className="font-display text-sm font-medium text-sidebar-primary truncate">
            {note.title}
          </span>
        </div>

        {/* Similarity score - warm amber for high scores */}
        <span className={cn(
          'text-xs font-medium shrink-0 px-1.5 py-0.5 rounded',
          note.similarity >= 90
            ? 'text-amber-700 dark:text-amber-400 bg-amber-500/10'
            : note.similarity >= 75
              ? 'text-blue-600 dark:text-blue-400 bg-blue-500/10'
              : 'text-sidebar-foreground/60 bg-sidebar-accent/30'
        )}>
          {note.similarity}%
        </span>
      </div>

      {/* Context Snippet - scholarly italic */}
      <p className="font-serif text-xs italic text-sidebar-foreground/60 line-clamp-2 mb-2.5 pl-8">
        "{note.reason}"
      </p>

      {/* Bottom row: Metadata */}
      <div className="flex items-center justify-between pl-8">
        <div className="flex items-center gap-1.5 text-xs text-sidebar-foreground/40">
          {note.folder && (
            <>
              <Folder className="h-3 w-3" />
              <span className="font-sans">{note.folder}</span>
              <span className="mx-1 text-sidebar-border">•</span>
            </>
          )}
          <span className="font-sans">{formatRelativeTime(note.updatedAt)}</span>
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
                'p-1 rounded-md hover:bg-sidebar-accent/50 transition-all duration-150',
                'text-sidebar-foreground/40 hover:text-sidebar-foreground',
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

          {/* Arrow indicator with warm accent */}
          <ChevronRight className={cn(
            'size-4 transition-all duration-200',
            'text-sidebar-foreground/30 group-hover:text-amber-500/70',
            'opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5'
          )} />
        </div>
      </div>
    </div>
  )
}
