import { useState, useEffect } from 'react'
import { FileText, X, Link, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { NoteSearchDropdown } from './note-search-dropdown'
import { cn } from '@/lib/utils'
import { notesService, type Note } from '@/services/notes-service'

// ============================================================================
// TYPES
// ============================================================================

interface TaskLinksSectionProps {
  linkedNoteIds: string[]
  onAddLink: (noteId: string) => void
  onRemoveLink: (noteId: string) => void
  onNoteClick?: (noteId: string) => void
  className?: string
}

// ============================================================================
// LINKED NOTE ITEM
// ============================================================================

interface LinkedNoteItemProps {
  noteId: string
  onRemove: () => void
  onClick?: () => void
}

const LinkedNoteItem = ({
  noteId,
  onRemove,
  onClick
}: LinkedNoteItemProps): React.JSX.Element | null => {
  const [note, setNote] = useState<Note | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    setIsLoading(true)
    notesService
      .get(noteId)
      .then(setNote)
      .catch(() => setNote(null))
      .finally(() => setIsLoading(false))
  }, [noteId])

  if (isLoading) {
    return (
      <div className="group flex items-center gap-2 rounded-sm border border-border bg-muted/30 px-3 py-2">
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="flex-1 truncate text-sm text-muted-foreground">Loading...</span>
      </div>
    )
  }

  if (!note) {
    return (
      <div className="group flex items-center gap-2 rounded-sm border border-border bg-muted/30 px-3 py-2">
        <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1 truncate text-sm text-muted-foreground italic">Note not found</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          aria-label="Remove broken link"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'group flex items-center gap-2 rounded-sm border border-border bg-muted/30 px-3 py-2',
        onClick && 'cursor-pointer hover:bg-muted/50 transition-colors'
      )}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onClick) {
          onClick()
        }
      }}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
      <span className="flex-1 truncate text-sm">{note.title}</span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        aria-label={`Remove link to ${note.title}`}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}

// ============================================================================
// TASK LINKS SECTION COMPONENT
// ============================================================================

export const TaskLinksSection = ({
  linkedNoteIds,
  onAddLink,
  onRemoveLink,
  onNoteClick,
  className
}: TaskLinksSectionProps): React.JSX.Element => {
  const handleRemoveLink = (noteId: string) => (): void => {
    onRemoveLink(noteId)
  }

  const handleNoteClick = (noteId: string) => (): void => {
    onNoteClick?.(noteId)
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* Section label */}
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Linked Notes
      </h3>

      {/* Linked notes list */}
      {linkedNoteIds.length > 0 && (
        <div className="flex flex-col gap-2">
          {linkedNoteIds.map((noteId) => (
            <LinkedNoteItem
              key={noteId}
              noteId={noteId}
              onRemove={handleRemoveLink(noteId)}
              onClick={onNoteClick ? handleNoteClick(noteId) : undefined}
            />
          ))}
        </div>
      )}

      {/* Add link button with dropdown */}
      <NoteSearchDropdown onSelectNote={onAddLink} excludeNoteIds={linkedNoteIds}>
        <button
          type="button"
          className={cn(
            'flex items-center gap-2 rounded-sm border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors',
            'hover:border-primary hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring'
          )}
        >
          <Link className="size-4" aria-hidden="true" />
          <span>Link to a note...</span>
        </button>
      </NoteSearchDropdown>
    </div>
  )
}

export default TaskLinksSection
