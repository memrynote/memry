/**
 * Today's Notes Section Component
 * Shows timestamped list of all notes created on the current day
 */

import { memo, useState } from 'react'
import { FileText, ChevronRight, Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { Note } from '@/hooks/use-notes-query'
import { formatTimeOfDay } from '@/lib/time-format'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useT } from '@memry/i18n/renderer'

// =============================================================================
// TYPES
// =============================================================================

export interface TodaysNotesSectionProps {
  /** List of today's notes */
  notes: Note[]
  /** Callback when note is clicked */
  onNoteClick?: (noteId: string) => void
  /** Currently active note ID (shown in drawer) */
  activeNoteId?: string | null
  /** Callback when create button is clicked */
  onCreate?: (title: string) => void
  /** Max items to show before expand */
  maxItems?: number
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export const TodaysNotesSection = memo(function TodaysNotesSection({
  notes,
  onNoteClick,
  activeNoteId,
  onCreate,
  maxItems = 3
}: TodaysNotesSectionProps): React.JSX.Element {
  const { t, i18n } = useT('journal')
  const [isExpanded, setIsExpanded] = useState(false)

  const visibleNotes = isExpanded ? notes : notes.slice(0, maxItems)
  const hiddenCount = notes.length - maxItems

  const handleCreateNote = () => {
    const now = new Date()
    const date = now.toLocaleString(i18n.language, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
    const title = t('note.generatedTitle', { date })
    onCreate?.(title)
  }

  return (
    <section
      aria-label={t('section.todaysNotes')}
      aria-live="polite"
      className="rounded-md border border-border/40 bg-card overflow-hidden"
    >
      {/* Header */}
      <NotesSectionHeader count={notes.length} onCreate={onCreate ? handleCreateNote : undefined} />

      {/* Content */}
      <div className="p-3">
        {/* Empty State */}
        {notes.length === 0 && <EmptyState onCreate={onCreate ? handleCreateNote : undefined} />}

        {/* Notes List */}
        {notes.length > 0 && (
          <div className="flex flex-col gap-2">
            {visibleNotes.map((note) => (
              <NoteItem
                key={note.id}
                note={note}
                isActive={note.id === activeNoteId}
                onClick={() => onNoteClick?.(note.id)}
              />
            ))}

            {/* Expand/Collapse Button */}
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                className={cn(
                  'w-full py-2 px-3 mt-1',
                  'text-sm text-muted-foreground hover:text-foreground',
                  'border border-dashed border-border/60 rounded-md',
                  'hover:bg-muted/50 transition-colors',
                  'flex items-center justify-center gap-1'
                )}
                aria-label={
                  isExpanded
                    ? t('action.showFewerNotes')
                    : hiddenCount === 1
                      ? t('action.showMoreNotes', { count: hiddenCount })
                      : t('action.showMoreNotes_plural', { count: hiddenCount })
                }
              >
                {isExpanded ? (
                  <>{t('action.showLess')}</>
                ) : (
                  <>
                    {hiddenCount === 1
                      ? t('count.moreNotes', { count: hiddenCount })
                      : t('count.moreNotes_plural', { count: hiddenCount })}
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
})

// =============================================================================
// HEADER
// =============================================================================

interface NotesSectionHeaderProps {
  count: number
  onCreate?: () => void
}

function NotesSectionHeader({ count, onCreate }: NotesSectionHeaderProps): React.JSX.Element {
  const { t } = useT('journal')

  return (
    <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <FileText className="size-4 text-accent-green" />
        <span className="text-sm font-medium">{t('section.todaysNotes')}</span>
      </div>

      <div className="flex items-center gap-2">
        {/* Create button */}
        {onCreate && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={onCreate}
            title={t('action.createNewNote')}
            aria-label={t('action.createNewNote')}
          >
            <Plus className="size-3.5" />
          </Button>
        )}

        {/* Count badge */}
        {count > 0 && (
          <span
            className="text-xs text-muted-foreground"
            aria-label={t('aria.notesCreatedToday', { count })}
          >
            ({count})
          </span>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// NOTE ITEM
// =============================================================================

interface NoteItemProps {
  note: Note
  isActive: boolean
  onClick?: () => void
}

function NoteItem({ note, isActive, onClick }: NoteItemProps): React.JSX.Element {
  const { t } = useT('journal')
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const time = formatTimeOfDay(new Date(note.created), clockFormat)

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-start p-3 rounded-md',
        'border transition-all duration-150',
        'group cursor-pointer',
        isActive
          ? 'bg-accent/10 border-accent/30'
          : 'bg-muted/30 hover:bg-muted/60 border-transparent hover:border-border/40'
      )}
      aria-label={t('note.openAria', { title: note.title, time })}
      aria-current={isActive ? 'true' : undefined}
    >
      {/* Time */}
      <div className="text-xs text-muted-foreground mb-1">{time}</div>

      {/* Title row with icon and arrow */}
      <div className="flex items-center gap-2">
        <FileText className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-sm text-foreground flex-1 truncate">{note.title}</span>
        <ChevronRight
          className={cn(
            'size-4 transition-opacity shrink-0',
            isActive
              ? 'text-accent opacity-100'
              : 'text-muted-foreground opacity-0 group-hover:opacity-100'
          )}
        />
      </div>
    </button>
  )
}

// =============================================================================
// EMPTY STATE
// =============================================================================

interface EmptyStateProps {
  onCreate?: () => void
}

function EmptyState({ onCreate }: EmptyStateProps): React.JSX.Element {
  const { t } = useT('journal')

  return (
    <div className="py-8 flex flex-col items-center justify-center text-center">
      <FileText className="size-8 text-muted-foreground/40 mb-3" />
      <p className="text-sm font-medium text-muted-foreground mb-1">{t('empty.noNotesToday')}</p>
      <p className="text-xs text-muted-foreground/70 mb-4">{t('empty.startDocumenting')}</p>
      {onCreate && (
        <Button variant="outline" size="sm" onClick={onCreate}>
          <Plus className="size-4 me-2" />
          {t('action.createNote')}
        </Button>
      )}
    </div>
  )
}

export default TodaysNotesSection
