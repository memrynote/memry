import { useEffect, useState } from 'react'

import { ArrowUpRight, FileText } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notesService } from '@/services/notes-service'
import type { Task } from '@/data/task-model'

const FALLBACK_NOTE_TITLE = 'Linked note'

interface TaskLinkedNoteIndicatorProps {
  task: Task
  onNoteClick?: (noteId: string) => void
  className?: string
}

const getRelatedNoteIds = (task: Task): string[] => {
  if (task.linkedNoteIds.length > 0) {
    return task.linkedNoteIds
  }
  return task.sourceNoteId ? [task.sourceNoteId] : []
}

export function TaskLinkedNoteIndicator({
  task,
  onNoteClick,
  className
}: TaskLinkedNoteIndicatorProps): React.JSX.Element | null {
  const noteIds = getRelatedNoteIds(task)
  const primaryNoteId = noteIds[0]
  const extraCount = Math.max(noteIds.length - 1, 0)
  const [loadedNote, setLoadedNote] = useState<{ noteId: string; title: string } | null>(null)
  const noteTitle =
    loadedNote && loadedNote.noteId === primaryNoteId ? loadedNote.title : FALLBACK_NOTE_TITLE

  useEffect(() => {
    if (!primaryNoteId) return

    let isCurrent = true

    void notesService
      .get(primaryNoteId)
      .then((note) => {
        if (!isCurrent) return
        setLoadedNote({
          noteId: primaryNoteId,
          title: note?.title?.trim() || FALLBACK_NOTE_TITLE
        })
      })
      .catch(() => {
        if (!isCurrent) return
        setLoadedNote({ noteId: primaryNoteId, title: FALLBACK_NOTE_TITLE })
      })

    return () => {
      isCurrent = false
    }
  }, [primaryNoteId])

  if (!primaryNoteId) return null

  const handleOpenNote = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    onNoteClick?.(primaryNoteId)
  }

  const stopRowInteraction = (event: React.SyntheticEvent): void => {
    event.stopPropagation()
  }

  return (
    <button
      type="button"
      aria-label={`Open note ${noteTitle}`}
      title={noteTitle}
      onClick={handleOpenNote}
      onPointerDown={stopRowInteraction}
      onMouseDown={stopRowInteraction}
      className={cn(
        'inline-flex h-6 max-w-6 shrink-0 items-center justify-end gap-1 overflow-hidden',
        'rounded-sm border border-transparent px-1.5 text-[11px] leading-none',
        'text-text-tertiary transition-[max-width,color,background-color,border-color] duration-150',
        'hover:border-border hover:bg-background/80 hover:text-text-secondary',
        'focus-visible:max-w-[180px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'group-hover:max-w-[180px] group-focus-within:max-w-[180px]',
        className
      )}
    >
      <FileText className="size-3 shrink-0" aria-hidden="true" />
      <span
        className={cn(
          'min-w-0 max-w-0 truncate opacity-0 transition-[max-width,opacity] duration-150',
          'group-hover:max-w-[120px] group-hover:opacity-100',
          'group-focus-within:max-w-[120px] group-focus-within:opacity-100',
          'focus-visible:max-w-[120px] focus-visible:opacity-100'
        )}
      >
        {noteTitle}
      </span>
      {extraCount > 0 && (
        <span
          className={cn(
            'shrink-0 opacity-0 transition-opacity duration-150',
            'group-hover:opacity-100 group-focus-within:opacity-100'
          )}
        >
          +{extraCount}
        </span>
      )}
      <ArrowUpRight
        className={cn(
          'size-3 shrink-0 opacity-0 transition-opacity duration-150',
          'group-hover:opacity-100 group-focus-within:opacity-100'
        )}
        aria-hidden="true"
      />
    </button>
  )
}

export default TaskLinkedNoteIndicator
