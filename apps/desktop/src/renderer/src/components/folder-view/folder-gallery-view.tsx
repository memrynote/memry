/**
 * Folder Gallery (Grid) View
 *
 * Notes as cards with a tinted cover (theme-aware --card-* pastels), large emoji,
 * title, tags, and folder + modified metadata.
 *
 * ponytail: no virtualization yet — fine for typical folders; add windowing if
 * a folder routinely exceeds ~500 notes.
 */

import { useMemo } from 'react'
import { Folder } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'
import { FolderViewEmptyState } from './folder-view-empty-state'
import { TagChip } from '@/components/note/tags-row/TagChip'
import {
  toTagChip,
  pastelFor,
  formatRelative,
  NoteCardKindIcon,
  type TagMetaMap
} from './note-card-pieces'

export interface FolderGalleryViewProps {
  notes: NoteWithProperties[]
  searchQuery?: string
  tagMetaMap: TagMetaMap
  onNoteOpen: (noteId: string) => void
  onTagClick?: (tag: string) => void
  onCreateNote?: () => void
  onClearAll?: () => void
  className?: string
}

export function FolderGalleryView({
  notes,
  searchQuery,
  tagMetaMap,
  onNoteOpen,
  onTagClick,
  onCreateNote,
  onClearAll,
  className
}: FolderGalleryViewProps): React.JSX.Element {
  const q = searchQuery?.trim().toLowerCase() ?? ''
  const visible = useMemo(() => {
    if (!q) return notes
    return notes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q))
    )
  }, [notes, q])

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
      className={cn('flex h-full flex-wrap content-start gap-4 overflow-auto p-[18px]', className)}
    >
      {visible.map((note) => (
        <div
          key={note.id}
          role="button"
          tabIndex={0}
          onClick={() => onNoteOpen(note.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onNoteOpen(note.id)
            }
          }}
          className="flex w-[272px] cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <div
            className={cn(
              'flex h-[90px] items-center justify-center',
              pastelFor(note.emoji || note.title || note.id)
            )}
          >
            <span className="text-[34px] leading-none">{note.emoji || '📄'}</span>
          </div>
          <div className="flex flex-col gap-2 p-3">
            {note.kind === 'task' || note.kind === 'inbox' ? (
              <div className="flex items-center gap-1.5">
                <NoteCardKindIcon kind={note.kind} />
                <span className="line-clamp-2 text-[13px] font-semibold leading-[17px] text-foreground">
                  {note.title || 'Untitled'}
                </span>
              </div>
            ) : (
              <span className="line-clamp-2 text-[13px] font-semibold leading-[17px] text-foreground">
                {note.title || 'Untitled'}
              </span>
            )}
            {note.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {note.tags.slice(0, 3).map((tag) => (
                  <TagChip
                    key={tag}
                    tag={toTagChip(tag, tagMetaMap.get(tag.toLowerCase()))}
                    onClick={onTagClick ? () => onTagClick(tag) : undefined}
                  />
                ))}
              </div>
            )}
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Folder className="size-3 shrink-0" />
              <span className="truncate">{note.folder ? note.folder.replace(/^\//, '') : '—'}</span>
              <div className="flex-1" />
              <span className="tabular-nums">{formatRelative(note.modified)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default FolderGalleryView
