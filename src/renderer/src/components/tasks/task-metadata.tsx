import { useState, useEffect } from 'react'
import { FileText, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { notesService, type Note } from '@/services/notes-service'

// ============================================================================
// TYPES
// ============================================================================

interface TaskMetadataProps {
  createdAt: Date
  completedAt: Date | null
  sourceNoteId: string | null
  className?: string
}

// ============================================================================
// DATE FORMATTING
// ============================================================================

const formatMetadataDate = (date: Date): string => {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

// ============================================================================
// TASK METADATA COMPONENT
// ============================================================================

export const TaskMetadata = ({
  createdAt,
  completedAt,
  sourceNoteId,
  className
}: TaskMetadataProps): React.JSX.Element => {
  const [sourceNote, setSourceNote] = useState<Note | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (sourceNoteId) {
      setIsLoading(true)
      notesService
        .get(sourceNoteId)
        .then(setSourceNote)
        .catch(() => setSourceNote(null))
        .finally(() => setIsLoading(false))
    } else {
      setSourceNote(null)
    }
  }, [sourceNoteId])

  return (
    <div className={cn('flex flex-col gap-1 text-xs text-muted-foreground', className)}>
      {/* Created date */}
      <p>Created {formatMetadataDate(createdAt)}</p>

      {/* Completed date (only shown if completed) */}
      {completedAt && <p>Completed {formatMetadataDate(completedAt)}</p>}

      {/* Source note (if extracted from a note) */}
      {isLoading && sourceNoteId && (
        <p className="flex items-center gap-1.5">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          <span>Loading source note...</span>
        </p>
      )}
      {!isLoading && sourceNote && (
        <p className="flex items-center gap-1.5">
          <FileText className="size-3" aria-hidden="true" />
          <span>From: {sourceNote.title}</span>
        </p>
      )}
    </div>
  )
}

export default TaskMetadata
