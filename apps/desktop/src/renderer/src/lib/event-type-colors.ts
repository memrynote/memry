import type { CalendarProjectionItem } from '@/services/calendar-service'
import { withAlpha } from './color'

type VisualType = CalendarProjectionItem['visualType']

export const EVENT_BG_OPACITY = 0.5

export const EVENT_TYPE_COLORS: Record<VisualType, string> = {
  event: '#92CED4',
  task: '#1EB06D',
  reminder: '#1BADF8',
  snooze: '#7BD148',
  external_event: '#9A9CFF'
}

export function getEventBaseColor(type: VisualType): string {
  return EVENT_TYPE_COLORS[type]
}

export function getEventBgColor(type: VisualType): string {
  return withAlpha(EVENT_TYPE_COLORS[type], EVENT_BG_OPACITY)
}

export function getEventTextColor(type: VisualType): string {
  return EVENT_TYPE_COLORS[type]
}
