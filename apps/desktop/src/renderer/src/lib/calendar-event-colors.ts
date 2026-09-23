import type { CSSProperties } from 'react'
import type { CalendarEventColor } from '@memry/contracts/calendar-event-colors'

/** Share of the hue in a resting chip's fill; the rest is --background. */
export const CALENDAR_EVENT_FILL_PERCENT = 20

export function calendarEventColorVar(color: CalendarEventColor): string {
  return `var(--calendar-event-${color})`
}

export function calendarEventChipStyle(
  color: CalendarEventColor,
  isSelected: boolean
): CSSProperties {
  const hue = calendarEventColorVar(color)
  return isSelected
    ? { backgroundColor: hue, color: 'var(--calendar-event-on-color)' }
    : {
        backgroundColor: `color-mix(in srgb, ${hue} ${CALENDAR_EVENT_FILL_PERCENT}%, var(--background))`,
        color: 'var(--foreground)'
      }
}
