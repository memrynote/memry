import type { CSSProperties } from 'react'
import { EVENT_TYPE_COLORS } from '@/lib/event-type-colors'
import type { CalendarProjectionVisualType } from '@/services/calendar-service'

interface VisualTypeMeta {
  labelKey:
    | 'visual-type.event'
    | 'visual-type.imported-event'
    | 'visual-type.task'
    | 'visual-type.reminder'
    | 'visual-type.snooze'
    | 'visual-type.note'
    | 'visual-type.note-date'
  swatchColor: string
  /** Legend swatch fill. A note date shares the note hue, so its swatch is a dashed ring, like its chip. */
  swatchStyle: CSSProperties
  dotColor: string
}

function solidSwatch(color: string): CSSProperties {
  return { backgroundColor: color }
}

export const VISUAL_TYPE_META: Record<CalendarProjectionVisualType, VisualTypeMeta> = {
  event: {
    labelKey: 'visual-type.event',
    swatchColor: EVENT_TYPE_COLORS.event,
    swatchStyle: solidSwatch(EVENT_TYPE_COLORS.event),
    dotColor: EVENT_TYPE_COLORS.event
  },
  external_event: {
    labelKey: 'visual-type.imported-event',
    swatchColor: EVENT_TYPE_COLORS.external_event,
    swatchStyle: solidSwatch(EVENT_TYPE_COLORS.external_event),
    dotColor: EVENT_TYPE_COLORS.external_event
  },
  task: {
    labelKey: 'visual-type.task',
    swatchColor: EVENT_TYPE_COLORS.task,
    swatchStyle: solidSwatch(EVENT_TYPE_COLORS.task),
    dotColor: EVENT_TYPE_COLORS.task
  },
  reminder: {
    labelKey: 'visual-type.reminder',
    swatchColor: EVENT_TYPE_COLORS.reminder,
    swatchStyle: solidSwatch(EVENT_TYPE_COLORS.reminder),
    dotColor: EVENT_TYPE_COLORS.reminder
  },
  snooze: {
    labelKey: 'visual-type.snooze',
    swatchColor: EVENT_TYPE_COLORS.snooze,
    swatchStyle: solidSwatch(EVENT_TYPE_COLORS.snooze),
    dotColor: EVENT_TYPE_COLORS.snooze
  },
  note: {
    labelKey: 'visual-type.note',
    swatchColor: EVENT_TYPE_COLORS.note,
    swatchStyle: solidSwatch(EVENT_TYPE_COLORS.note),
    dotColor: EVENT_TYPE_COLORS.note
  },
  note_date: {
    labelKey: 'visual-type.note-date',
    swatchColor: EVENT_TYPE_COLORS.note_date,
    swatchStyle: { border: `1.5px dashed ${EVENT_TYPE_COLORS.note_date}` },
    dotColor: EVENT_TYPE_COLORS.note_date
  }
}

export const VISUAL_TYPE_ORDER: CalendarProjectionVisualType[] = [
  'event',
  'external_event',
  'task',
  'reminder',
  'snooze',
  'note',
  'note_date'
]
