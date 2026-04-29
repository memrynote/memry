import { EVENT_TYPE_COLORS } from '@/lib/event-type-colors'
import type { CalendarProjectionVisualType } from '@/services/calendar-service'

interface VisualTypeMeta {
  labelKey:
    | 'visual-type.event'
    | 'visual-type.imported-event'
    | 'visual-type.task'
    | 'visual-type.reminder'
    | 'visual-type.snooze'
  swatchColor: string
  dotColor: string
}

export const VISUAL_TYPE_META: Record<CalendarProjectionVisualType, VisualTypeMeta> = {
  event: {
    labelKey: 'visual-type.event',
    swatchColor: EVENT_TYPE_COLORS.event,
    dotColor: EVENT_TYPE_COLORS.event
  },
  external_event: {
    labelKey: 'visual-type.imported-event',
    swatchColor: EVENT_TYPE_COLORS.external_event,
    dotColor: EVENT_TYPE_COLORS.external_event
  },
  task: {
    labelKey: 'visual-type.task',
    swatchColor: EVENT_TYPE_COLORS.task,
    dotColor: EVENT_TYPE_COLORS.task
  },
  reminder: {
    labelKey: 'visual-type.reminder',
    swatchColor: EVENT_TYPE_COLORS.reminder,
    dotColor: EVENT_TYPE_COLORS.reminder
  },
  snooze: {
    labelKey: 'visual-type.snooze',
    swatchColor: EVENT_TYPE_COLORS.snooze,
    dotColor: EVENT_TYPE_COLORS.snooze
  }
}

export const VISUAL_TYPE_ORDER: CalendarProjectionVisualType[] = [
  'event',
  'external_event',
  'task',
  'reminder',
  'snooze'
]
