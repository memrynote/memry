/**
 * Folder List View
 *
 * Compact, title-centric single-line list of notes (Linear-vibe). A lighter
 * alternative to the spreadsheet table: title + inline tags + trailing metadata.
 *
 * ponytail: no virtualization yet — fine for typical folders; add windowing if
 * a folder routinely exceeds ~500 notes.
 */

import { useCallback, useMemo, useRef } from 'react'
import { FileText } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useTabScrollRestore } from '@/hooks/use-tab-scroll-restore'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'
import { FolderViewEmptyState } from './folder-view-empty-state'
import { TagChip } from '@/components/note/tags-row/TagChip'
import { toTagChip, formatRelative, NoteCardKindIcon, type TagMetaMap } from './note-card-pieces'

export interface FolderListViewProps {
  notes: NoteWithProperties[]
  searchQuery?: string
  density?: 'comfortable' | 'compact'
  tagMetaMap: TagMetaMap
  onNoteOpen: (noteId: string) => void
  onTagClick?: (tag: string) => void
  onCreateNote?: () => void
  onClearAll?: () => void
  /**
   * Names this scroller inside the owning tab, turning scroll restore on. Left
   * unset by callers that are not a tab's main content (the Home folder widget),
   * where there is no per-tab offset to restore.
   */
  scrollKey?: string
  className?: string
}

export function FolderListView({
  notes,
  searchQuery,
  density = 'comfortable',
  tagMetaMap,
  onNoteOpen,
  onTagClick,
  onCreateNote,
  onClearAll,
  scrollKey,
  className
}: FolderListViewProps): React.JSX.Element {
  const q = searchQuery?.trim().toLowerCase() ?? ''
  const visible = useMemo(() => {
    if (!q) return notes
    return notes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q))
    )
  }, [notes, q])

  // Called before the empty-state early return, as hooks must be. The empty
  // state renders no scroller at all, so restore stays off until rows exist —
  // and flipping `enabled` back on is what re-runs it when they arrive.
  const scrollRef = useRef<HTMLMenuElement>(null)
  const getScrollElement = useCallback(() => scrollRef.current, [])
  useTabScrollRestore({
    getScrollElement,
    key: scrollKey,
    enabled: scrollKey !== undefined && visible.length > 0
  })

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

  const rowH = density === 'compact' ? 'h-8' : 'h-10'

  return (
    <menu ref={scrollRef} className={cn('h-full overflow-auto py-1', className)}>
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
          className={cn(
            'group flex w-full cursor-pointer items-center gap-2.5 px-5 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60',
            rowH
          )}
        >
          {note.emoji ? (
            <span className="shrink-0 text-sm leading-none">{note.emoji}</span>
          ) : (
            <FileText className="size-[15px] shrink-0 text-muted-foreground/70" />
          )}
          <span className="shrink-0 truncate text-[13px] font-medium text-foreground/90">
            {note.title || 'Untitled'}
          </span>
          <NoteCardKindIcon kind={note.kind} />
          <div className="flex shrink-0 items-center gap-1.5">
            {note.tags.slice(0, 3).map((tag) => (
              <TagChip
                key={tag}
                tag={toTagChip(tag, tagMetaMap.get(tag.toLowerCase()))}
                onClick={onTagClick ? () => onTagClick(tag) : undefined}
              />
            ))}
          </div>
          <div className="flex-1" />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
            {`${note.wordCount.toLocaleString()}w`}
          </span>
          <span className="w-16 shrink-0 text-end text-[11px] tabular-nums text-muted-foreground/60">
            {formatRelative(note.modified)}
          </span>
        </div>
      ))}
    </menu>
  )
}

export default FolderListView
