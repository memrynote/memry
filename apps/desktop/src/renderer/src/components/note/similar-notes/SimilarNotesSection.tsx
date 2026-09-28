import { useId, useState } from 'react'
import type { SimilarNoteItem } from '@memry/contracts/notes-api'
import { useT } from '@memry/i18n/renderer'
import { ChevronDown, Link2, Network } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { AddToCanvasPicker, type CanvasOption } from './AddToCanvasPicker'

interface SimilarNotesSectionProps {
  notes: SimilarNoteItem[]
  onOpen: (note: SimilarNoteItem) => void
  /** Absent when this note cannot take a link right now (no live editor). */
  onLink?: (note: SimilarNoteItem) => void
  /** Absent when canvases are turned off. */
  onAddToCanvas?: (note: SimilarNoteItem, canvas: CanvasOption) => void
}

function folderOf(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}

/**
 * Notes that resemble this one but are not linked to it yet, from the local
 * embeddings. Renders nothing when there are none, so a vault with the model
 * off (or a note too short to embed) shows no empty section.
 */
export function SimilarNotesSection({
  notes,
  onOpen,
  onLink,
  onAddToCanvas
}: SimilarNotesSectionProps): React.JSX.Element | null {
  const { t } = useT('notes')
  const contentId = useId()
  const [isCollapsed, setIsCollapsed] = useState(false)

  if (notes.length === 0) return null

  return (
    <section
      className="flex flex-col gap-1"
      aria-label={t('similarNotes.sectionAria')}
      data-testid="similar-notes"
    >
      <button
        type="button"
        onClick={() => setIsCollapsed(!isCollapsed)}
        className={cn(
          'flex items-center gap-1.5 self-start rounded',
          'cursor-pointer hover:opacity-80 transition-opacity',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-border'
        )}
        aria-expanded={!isCollapsed}
        aria-controls={contentId}
        title={t('similarNotes.hint')}
      >
        <ChevronDown
          className={cn(
            'h-3 w-3 text-text-tertiary flex-shrink-0 transition-transform duration-150',
            isCollapsed && '-rotate-90'
          )}
          aria-hidden="true"
        />
        <Network className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
        <span className="text-xs/4 font-medium text-text-tertiary">
          {t('similarNotes.summary', { count: notes.length })}
        </span>
      </button>

      {!isCollapsed && (
        <ul id={contentId} className="flex flex-col">
          {notes.map((note) => {
            const folder = folderOf(note.path)
            return (
              <li
                key={note.id}
                className="group flex min-w-0 items-center gap-1 rounded hover:bg-surface-active/40 focus-within:bg-surface-active/40"
              >
                <button
                  type="button"
                  onClick={() => onOpen(note)}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1',
                    'rounded text-start cursor-pointer',
                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-border'
                  )}
                >
                  {note.emoji ? (
                    <span className="flex-shrink-0 text-[13px]/4" aria-hidden="true">
                      {note.emoji}
                    </span>
                  ) : null}
                  <span className="truncate text-[13px]/4 font-medium text-text-bright">
                    {note.title}
                  </span>
                  {folder ? (
                    <span className="flex-shrink truncate text-[11px] text-text-tertiary">
                      {folder}
                    </span>
                  ) : null}
                </button>
                <div className="flex flex-shrink-0 items-center gap-0.5 pe-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  {onLink ? (
                    <button
                      type="button"
                      onClick={() => onLink(note)}
                      aria-label={t('similarNotes.addLinkAria', { title: note.title })}
                      title={t('similarNotes.addLink')}
                      className={cn(
                        'flex size-6 items-center justify-center rounded text-text-tertiary',
                        'hover:bg-surface-active/60 hover:text-foreground transition-colors',
                        'focus:outline-none focus-visible:ring-1 focus-visible:ring-border'
                      )}
                    >
                      <Link2 className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                  {onAddToCanvas ? (
                    <AddToCanvasPicker
                      noteTitle={note.title}
                      onPick={(canvas) => onAddToCanvas(note, canvas)}
                    />
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
