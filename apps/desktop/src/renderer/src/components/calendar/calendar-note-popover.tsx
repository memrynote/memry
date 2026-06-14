import { useEffect, useRef } from 'react'
import { format } from 'date-fns'
import { useT } from '@memry/i18n/renderer'

import { Button } from '@/components/ui/button'
import { StickyNote } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { AnchorRect } from './types'
import { POPOVER_WIDTH, computePopoverPosition } from './popover-position'
import type { CalendarProjectionItem } from '@/services/calendar-service'

interface CalendarNotePopoverProps {
  item: CalendarProjectionItem
  anchorRect: AnchorRect
  onOpenNote: (noteId: string, anchorId?: string | null) => void
  onDismiss: () => void
}

export function CalendarNotePopover({
  item,
  anchorRect,
  onOpenNote,
  onDismiss
}: CalendarNotePopoverProps): React.JSX.Element {
  const { t } = useT('calendar')
  const containerRef = useRef<HTMLDivElement>(null)
  const { top, left } = computePopoverPosition(anchorRect, { estimatedHeight: 160 })

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current) return
      if (containerRef.current.contains(event.target as Node)) return
      onDismiss()
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onDismiss()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onDismiss])

  // Two note-derived chips share this popover: the all-day date-property `note`
  // chip, and the timed `note_date` inline-pill reminder.
  const isNoteDate = item.visualType === 'note_date'
  const noteId = item.noteId ?? item.sourceId
  const anchorId = item.anchorId ?? null
  const kindLabel = isNoteDate ? t('notePopover.kindDateReminder') : t('notePopover.kind')

  // `descriptionPreview` carries the date property's name (e.g. "Deadline").
  // Timed items (`note_date`) also show the time of day.
  const dateLabel = format(
    new Date(item.startAt),
    item.isAllDay === false ? 'EEE d MMM · HH:mm' : 'EEE d MMM'
  )
  const metaLine = item.descriptionPreview ? `${item.descriptionPreview} · ${dateLabel}` : dateLabel

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={kindLabel}
      data-testid="calendar-note-popover"
      style={{ position: 'fixed', top, left, width: POPOVER_WIDTH }}
      className={cn(
        'z-50 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg',
        'flex flex-col gap-3'
      )}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <StickyNote className="h-3.5 w-3.5" />
          {kindLabel}
        </div>
        <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
        <p className="text-xs text-muted-foreground">{metaLine}</p>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-start"
        onClick={() => onOpenNote(noteId, anchorId)}
      >
        {t('notePopover.open')}
      </Button>
    </div>
  )
}

export default CalendarNotePopover
