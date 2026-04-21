import { EVENT_TYPE_COLORS } from '@/lib/event-type-colors'
import type { CalendarProjectionVisualType } from '@/services/calendar-service'

interface VisualTypeMeta {
  label: string
  swatchColor: string
  dotColor: string
}

export const VISUAL_TYPE_META: Record<CalendarProjectionVisualType, VisualTypeMeta> = {
  event: {
    label: 'Event',
    swatchColor: EVENT_TYPE_COLORS.event,
    dotColor: EVENT_TYPE_COLORS.event
  },
  external_event: {
    label: 'Imported event',
    swatchColor: EVENT_TYPE_COLORS.external_event,
    dotColor: EVENT_TYPE_COLORS.external_event
  },
  task: {
    label: 'Task',
    swatchColor: EVENT_TYPE_COLORS.task,
    dotColor: EVENT_TYPE_COLORS.task
  },
  reminder: {
    label: 'Reminder',
    swatchColor: EVENT_TYPE_COLORS.reminder,
    dotColor: EVENT_TYPE_COLORS.reminder
  },
  snooze: {
    label: 'Snooze',
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
