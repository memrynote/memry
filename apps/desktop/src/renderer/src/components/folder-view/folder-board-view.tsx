/**
 * Folder Board (Kanban) View
 *
 * Groups notes into columns by the folder's first `select` property (e.g. Status).
 * When no select property exists, falls back to a single "All notes" column.
 *
 * ponytail: no drag-to-reorder yet — read-only board; wire dnd-kit when the
 * write path (updating the group property on drop) is needed.
 */

import { useMemo } from 'react'
import { FileText, Folder, Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'
import { FolderViewEmptyState } from './folder-view-empty-state'
import { NoteTagPill, dotFor } from './note-card-pieces'

interface AvailableProp {
  name: string
  type: string
}

export interface FolderBoardViewProps {
  notes: NoteWithProperties[]
  searchQuery?: string
  tagColorMap: Map<string, string>
  availableProperties: AvailableProp[]
  onNoteOpen: (noteId: string) => void
  onTagClick?: (tag: string) => void
  onCreateNote?: () => void
  onClearAll?: () => void
  className?: string
}

const NO_VALUE = '—'

export function FolderBoardView({
  notes,
  searchQuery,
  tagColorMap,
  availableProperties,
  onNoteOpen,
  onTagClick,
  onCreateNote,
  onClearAll,
  className
}: FolderBoardViewProps): React.JSX.Element {
  const q = searchQuery?.trim().toLowerCase() ?? ''
  const visible = useMemo(() => {
    if (!q) return notes
    return notes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q))
    )
  }, [notes, q])

  const groupProp = useMemo(
    () => availableProperties.find((p) => p.type === 'select')?.name,
    [availableProperties]
  )

  const columns = useMemo(() => {
    if (!groupProp) return [{ key: '__all__', label: 'All notes', notes: visible }]
    const map = new Map<string, NoteWithProperties[]>()
    const order: string[] = []
    for (const note of visible) {
      const raw = note.properties?.[groupProp]
      const key =
        typeof raw === 'string' && raw !== ''
          ? raw
          : typeof raw === 'number'
            ? String(raw)
            : NO_VALUE
      const bucket = map.get(key)
      if (bucket) {
        bucket.push(note)
      } else {
        map.set(key, [note])
        order.push(key)
      }
    }
    // Keep the "no value" column last.
    order.sort((a, b) => (a === NO_VALUE ? 1 : 0) - (b === NO_VALUE ? 1 : 0))
    return order.map((key) => ({
      key,
      label: key === NO_VALUE ? `No ${groupProp}` : key,
      notes: map.get(key) ?? []
    }))
  }, [visible, groupProp])

  if (visible.length === 0) {
    return (
      <FolderViewEmptyState
        variant={q ? 'no-results' : 'empty'}
        onCreateNote={onCreateNote}
        onClearAll={onClearAll}
        className={cn('h-full', className)}
      />
    )
  }

  return (
    <div
      className={cn('flex h-full items-start gap-3.5 overflow-x-auto bg-muted/30 p-4', className)}
    >
      {columns.map((col, i) => (
        <div key={col.key} className="flex w-[300px] shrink-0 flex-col">
          <div className="flex items-center gap-2 px-1 pb-2.5 pt-0.5">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: dotFor(i) }}
              aria-hidden="true"
            />
            <span className="text-xs font-semibold text-foreground">{col.label}</span>
            <span className="text-[11px] tabular-nums text-muted-foreground/60">
              {col.notes.length}
            </span>
            <div className="flex-1" />
            <Plus className="size-3.5 text-muted-foreground/50" />
          </div>
          <div className="flex flex-col gap-2">
            {col.notes.map((note) => (
              <BoardCard
                key={note.id}
                note={note}
                tagColorMap={tagColorMap}
                onNoteOpen={onNoteOpen}
                onTagClick={onTagClick}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function BoardCard({
  note,
  tagColorMap,
  onNoteOpen,
  onTagClick
}: {
  note: NoteWithProperties
  tagColorMap: Map<string, string>
  onNoteOpen: (noteId: string) => void
  onTagClick?: (tag: string) => void
}): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onNoteOpen(note.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onNoteOpen(note.id)
        }
      }}
      className="flex cursor-pointer flex-col gap-2 rounded-[10px] border border-border bg-card p-2.5 shadow-sm outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <div className="flex items-start gap-2">
        {note.emoji ? (
          <span className="text-sm leading-[18px]">{note.emoji}</span>
        ) : (
          <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" />
        )}
        <span className="text-[13px] font-medium leading-[18px] text-foreground">
          {note.title || 'Untitled'}
        </span>
      </div>
      {note.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {note.tags.slice(0, 3).map((tag) => (
            <NoteTagPill
              key={tag}
              tag={tag}
              color={tagColorMap.get(tag.toLowerCase())}
              onClick={onTagClick ? () => onTagClick(tag) : undefined}
            />
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
        <Folder className="size-3 shrink-0" />
        <span className="truncate">{note.folder ? note.folder.replace(/^\//, '') : NO_VALUE}</span>
        <div className="flex-1" />
        <span className="tabular-nums">{`${note.wordCount.toLocaleString()}w`}</span>
      </div>
    </div>
  )
}

export default FolderBoardView
