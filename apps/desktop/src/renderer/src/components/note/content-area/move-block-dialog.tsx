/**
 * Picker for the block side menu's "Move to": choose the note a block is moved
 * into. The block is appended to the END of the chosen note's body.
 *
 * Deliberately has no "create a new note" row — moving and creating are two
 * failure points, and a failed create would leave the block in limbo.
 *
 * @module note/content-area/move-block-dialog
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { fuzzySearch } from '@/lib/fuzzy-search'
import { notesService } from '@/services/notes-service'
import { createLogger } from '@/lib/logger'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'

const log = createLogger('MoveBlockDialog')

interface NoteOption {
  id: string
  title: string
  path: string
}

export interface MoveBlockDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The note the block is being moved OUT of; never offered as a target. */
  currentNoteId: string
  onSelect: (targetNoteId: string) => void
}

export function MoveBlockDialog({
  open,
  onOpenChange,
  currentNoteId,
  onSelect
}: MoveBlockDialogProps) {
  const { t } = useT('notes')
  const [notes, setNotes] = useState<NoteOption[]>([])
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const result = await notesService.list({ limit: 500, sortBy: 'modified', fields: 'tree' })
        if (cancelled) return
        setNotes(
          (result?.notes ?? [])
            .filter((note: { id: string }) => note.id !== currentNoteId)
            .map((note: { id: string; title: string; path: string }) => ({
              id: note.id,
              title: note.title,
              path: note.path
            }))
        )
      } catch (err) {
        if (!cancelled) log.warn('Failed to load notes for move target picker', { error: err })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, currentNoteId])

  const results = useMemo(
    () => fuzzySearch(notes, query, ['title', 'path']).slice(0, 50),
    [notes, query]
  )

  // Clamped during render rather than reset in an effect: a narrowing query can
  // leave the cursor past the end of the list for one frame otherwise.
  const selectedIndex = Math.min(activeIndex, Math.max(results.length - 1, 0))

  const commit = useCallback(
    (index: number) => {
      const picked = results[index]
      if (!picked) return
      onSelect(picked.id)
      onOpenChange(false)
    },
    [results, onSelect, onOpenChange]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex(Math.min(selectedIndex + 1, results.length - 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex(Math.max(selectedIndex - 1, 0))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        commit(selectedIndex)
      }
    },
    [results.length, selectedIndex, commit]
  )

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-test="move-block-dialog">
        <DialogHeader>
          <DialogTitle>{t('editor.blockMenu.moveDialog.title')}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('editor.blockMenu.moveDialog.searchPlaceholder')}
          data-test="move-block-search"
        />
        <ScrollArea className="max-h-72">
          <div ref={listRef} className="flex flex-col gap-0.5 pe-2">
            {results.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                {t('editor.blockMenu.moveDialog.noResults')}
              </p>
            ) : (
              results.map((note, index) => (
                <button
                  key={note.id}
                  type="button"
                  data-active={index === selectedIndex}
                  data-test="move-block-option"
                  className={cn(
                    'flex flex-col items-start rounded-md px-2 py-1.5 text-start text-sm',
                    index === selectedIndex
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50'
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commit(index)}
                >
                  <span className="truncate font-medium">{note.title}</span>
                  <span className="truncate text-xs text-muted-foreground">{note.path}</span>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
