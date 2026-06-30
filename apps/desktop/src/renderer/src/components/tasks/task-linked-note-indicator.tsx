import { useEffect, useMemo, useState } from 'react'

import {
  ArrowUpRight,
  ChevronDown,
  FileAudio,
  FileImage,
  FilePdf,
  FileText,
  FileVideo
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { notesService } from '@/services/notes-service'
import type { Task } from '@/data/task-model'
import type { FileType } from '@memry/shared/file-types'

const FALLBACK_RELATED_TITLE = 'Related item'

interface LinkedNoteInfo {
  title: string
  emoji: string | null
  fileType: FileType
}

interface TaskLinkedNoteIndicatorProps {
  task: Task
  onNoteClick?: (noteId: string) => void
  className?: string
}

const getRelatedNoteIds = (linkedNoteIds: string[], sourceNoteId: string | null): string[] => {
  if (linkedNoteIds.length > 0) {
    return linkedNoteIds
  }
  return sourceNoteId ? [sourceNoteId] : []
}

const stopRowInteraction = (event: React.SyntheticEvent): void => {
  event.stopPropagation()
}

const RelatedItemIcon = ({
  fileType,
  className
}: {
  fileType: FileType
  className?: string
}): React.JSX.Element => {
  switch (fileType) {
    case 'pdf':
      return <FilePdf className={className} aria-hidden="true" />
    case 'image':
      return <FileImage className={className} aria-hidden="true" />
    case 'audio':
      return <FileAudio className={className} aria-hidden="true" />
    case 'video':
      return <FileVideo className={className} aria-hidden="true" />
    case 'markdown':
      return <FileText className={className} aria-hidden="true" />
  }
}

export function TaskLinkedNoteIndicator({
  task,
  onNoteClick,
  className
}: TaskLinkedNoteIndicatorProps): React.JSX.Element | null {
  const noteIds = useMemo(
    () => getRelatedNoteIds(task.linkedNoteIds, task.sourceNoteId),
    [task.linkedNoteIds, task.sourceNoteId]
  )
  const primaryNoteId = noteIds[0]
  const extraCount = Math.max(noteIds.length - 1, 0)
  const hasMultipleNotes = noteIds.length > 1
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [noteInfoById, setNoteInfoById] = useState<Record<string, LinkedNoteInfo>>({})
  const noteTitle = primaryNoteId
    ? noteInfoById[primaryNoteId]?.title || FALLBACK_RELATED_TITLE
    : ''

  useEffect(() => {
    if (noteIds.length === 0) return

    let isCurrent = true

    void Promise.all(
      noteIds.map(async (noteId) => {
        try {
          const file = await notesService.getFile(noteId)
          if (file) {
            return [
              noteId,
              {
                title: file.title?.trim() || FALLBACK_RELATED_TITLE,
                emoji: null,
                fileType: file.fileType
              }
            ] as const
          }

          const note = await notesService.get(noteId)
          return [
            noteId,
            {
              title: note?.title?.trim() || FALLBACK_RELATED_TITLE,
              emoji: note?.emoji?.trim() || null,
              fileType: 'markdown' as const
            }
          ] as const
        } catch {
          return [
            noteId,
            { title: FALLBACK_RELATED_TITLE, emoji: null, fileType: 'markdown' as const }
          ] as const
        }
      })
    ).then((entries) => {
      if (!isCurrent) return
      setNoteInfoById(Object.fromEntries(entries))
    })

    return () => {
      isCurrent = false
    }
  }, [noteIds])

  if (!primaryNoteId) return null

  const handleOpenNote = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    onNoteClick?.(primaryNoteId)
  }

  const isExpanded = hasMultipleNotes && isMenuOpen

  const trigger = (
    <button
      type="button"
      aria-label={hasMultipleNotes ? `Open related items for ${noteTitle}` : `Open ${noteTitle}`}
      title={noteTitle}
      onClick={hasMultipleNotes ? stopRowInteraction : handleOpenNote}
      onPointerDown={stopRowInteraction}
      onMouseDown={stopRowInteraction}
      onKeyDown={stopRowInteraction}
      className={cn(
        'inline-flex h-6 min-w-6 max-w-6 shrink-0 items-center justify-start gap-1 overflow-hidden',
        'rounded-sm border border-transparent px-1.5 text-[11px] leading-none',
        'text-text-tertiary transition-[max-width,color,background-color,border-color] duration-150',
        'hover:border-border hover:bg-background/80 hover:text-text-secondary',
        'focus-visible:max-w-[180px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'group-hover:max-w-[180px] group-focus-within:max-w-[180px]',
        isExpanded && 'max-w-[180px] border-border bg-background/80 text-text-secondary',
        className
      )}
    >
      <RelatedItemIcon
        fileType={noteInfoById[primaryNoteId]?.fileType ?? 'markdown'}
        className="size-3 shrink-0"
      />
      <span
        className={cn(
          'min-w-0 max-w-0 truncate opacity-0 transition-[max-width,opacity] duration-150',
          'group-hover:max-w-[120px] group-hover:opacity-100',
          'group-focus-within:max-w-[120px] group-focus-within:opacity-100',
          'focus-visible:max-w-[120px] focus-visible:opacity-100',
          isExpanded && 'max-w-[120px] opacity-100'
        )}
      >
        {noteTitle}
      </span>
      {extraCount > 0 && (
        <span
          className={cn(
            'shrink-0 opacity-0 transition-opacity duration-150',
            'group-hover:opacity-100 group-focus-within:opacity-100',
            isExpanded && 'opacity-100'
          )}
        >
          +{extraCount}
        </span>
      )}
      {hasMultipleNotes ? (
        <ChevronDown
          className={cn(
            'size-3 shrink-0 opacity-0 transition-opacity duration-150',
            'group-hover:opacity-100 group-focus-within:opacity-100',
            isExpanded && 'opacity-100'
          )}
          aria-hidden="true"
        />
      ) : (
        <ArrowUpRight
          className={cn(
            'size-3 shrink-0 opacity-0 transition-opacity duration-150',
            'group-hover:opacity-100 group-focus-within:opacity-100',
            isExpanded && 'opacity-100'
          )}
          aria-hidden="true"
        />
      )}
    </button>
  )

  if (!hasMultipleNotes) return trigger

  return (
    <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="w-52"
        onClick={stopRowInteraction}
        onPointerDown={stopRowInteraction}
        onMouseDown={stopRowInteraction}
      >
        {noteIds.map((noteId) => {
          const noteInfo = noteInfoById[noteId]
          const title = noteInfo?.title || FALLBACK_RELATED_TITLE
          return (
            <DropdownMenuItem
              key={noteId}
              onSelect={(event) => {
                event.stopPropagation()
                setIsMenuOpen(false)
                onNoteClick?.(noteId)
              }}
              className="cursor-pointer text-xs"
            >
              {noteInfo?.emoji ? (
                <span className="size-3.5 shrink-0 text-center text-[13px] leading-3.5">
                  {noteInfo.emoji}
                </span>
              ) : (
                <RelatedItemIcon
                  fileType={noteInfo?.fileType ?? 'markdown'}
                  className="size-3.5 text-text-tertiary"
                />
              )}
              <span className="min-w-0 truncate">{title}</span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default TaskLinkedNoteIndicator
