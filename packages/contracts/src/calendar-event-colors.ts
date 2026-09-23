import { z } from 'zod'

/**
 * The colours a user can give a Memry calendar event, in picker order.
 *
 * Renderer and IPC speak these names. Storage does not: `calendar_events.color_id`
 * holds Google Calendar's event colour id ("1".."11"), because that column
 * already existed, already syncs between devices, and is pushed to Google
 * verbatim by every released client. Writing a Memry name there would make an
 * older device with Google connected send an id Google rejects.
 */
export const CALENDAR_EVENT_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'gray'
] as const

export const CalendarEventColorSchema = z.enum(CALENDAR_EVENT_COLORS)
export type CalendarEventColor = z.infer<typeof CalendarEventColorSchema>

/** The Google colour id written when the user picks a colour in Memry. */
const COLOR_ID_BY_COLOR: Record<CalendarEventColor, string> = {
  red: '11',
  orange: '6',
  yellow: '5',
  green: '10',
  blue: '9',
  purple: '3',
  pink: '4',
  gray: '8'
}

/**
 * Every Google event colour id, folded onto the nearest Memry colour. Google
 * has eleven and Memry eight, so a colour set in Google (Lavender "1", Sage
 * "2", Peacock "7") shares a swatch with its neighbour.
 */
const COLOR_BY_COLOR_ID = new Map<string, CalendarEventColor>([
  ['1', 'purple'],
  ['2', 'green'],
  ['3', 'purple'],
  ['4', 'pink'],
  ['5', 'yellow'],
  ['6', 'orange'],
  ['7', 'blue'],
  ['8', 'gray'],
  ['9', 'blue'],
  ['10', 'green'],
  ['11', 'red']
])

export function calendarEventColorFromColorId(
  colorId: string | null | undefined
): CalendarEventColor | null {
  return colorId ? (COLOR_BY_COLOR_ID.get(colorId) ?? null) : null
}

export function colorIdForCalendarEventColor(color: CalendarEventColor | null): string | null {
  return color ? COLOR_ID_BY_COLOR[color] : null
}
