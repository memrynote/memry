import { z } from 'zod'

/**
 * Google Calendar's colour palette. Memry supports exactly the colours Google
 * does, no more and no fewer.
 *
 * Google keeps two palettes. A calendar takes one of 24 colours (calendar
 * colour ids "1".."24", listed here in id order). An event takes one of 11
 * (event colour ids "1".."11"), all of them also calendar colours, or none and
 * shows its calendar's colour. The hexes are the ones Google Calendar shows
 * today, not the 2012 values its API still returns.
 */
const CALENDAR_COLOR_HEX = {
  cocoa: '#795548',
  flamingo: '#e67c73',
  tomato: '#d50000',
  tangerine: '#f4511e',
  pumpkin: '#ef6c00',
  mango: '#f09300',
  eucalyptus: '#009688',
  basil: '#0b8043',
  pistachio: '#7cb342',
  avocado: '#c0ca33',
  citron: '#e4c441',
  banana: '#f6bf26',
  sage: '#33b679',
  peacock: '#039be5',
  cobalt: '#4285f4',
  blueberry: '#3f51b5',
  lavender: '#7986cb',
  wisteria: '#b39ddb',
  graphite: '#616161',
  birch: '#a79b8e',
  radicchio: '#ad1457',
  'cherry-blossom': '#d81b60',
  grape: '#8e24aa',
  amethyst: '#9e69af'
} as const

export type CalendarColor = keyof typeof CALENDAR_COLOR_HEX

/** Every calendar colour, in Google's calendar colour id order ("1".."24"). */
export const CALENDAR_COLORS = Object.keys(CALENDAR_COLOR_HEX) as CalendarColor[]

/**
 * `backgroundColor` as the Google API reports it for each calendar colour id,
 * in the same order as CALENDAR_COLORS. calendar_sources.color stores this
 * value, so it is how a synced calendar's colour is recognised.
 */
const LEGACY_CALENDAR_HEX = [
  '#ac725e',
  '#d06b64',
  '#f83a22',
  '#fa573c',
  '#ff7537',
  '#ffad46',
  '#42d692',
  '#16a765',
  '#7bd148',
  '#b3dc6c',
  '#fbe983',
  '#fad165',
  '#92e1c0',
  '#9fe1e7',
  '#9fc6e7',
  '#4986e7',
  '#9a9cff',
  '#b99aff',
  '#c2c2c2',
  '#cabdbf',
  '#cca6ac',
  '#f691b2',
  '#cd74e6',
  '#a47ae2'
] as const

/**
 * The colours an event can take, in the order Google's event colour menu
 * lists them.
 *
 * Renderer and IPC speak these names. Storage does not:
 * `calendar_events.color_id` holds Google's event colour id ("1".."11"),
 * because that column already existed, already syncs between devices, and is
 * pushed to Google verbatim by every released client. Writing a name there
 * would make an older device with Google connected send an id Google rejects.
 */
export const CALENDAR_EVENT_COLORS = [
  'tomato',
  'flamingo',
  'tangerine',
  'banana',
  'sage',
  'basil',
  'peacock',
  'blueberry',
  'lavender',
  'grape',
  'graphite'
] as const satisfies readonly CalendarColor[]

export const CalendarEventColorSchema = z.enum(CALENDAR_EVENT_COLORS)
export type CalendarEventColor = z.infer<typeof CalendarEventColorSchema>

/** Google's event colour id for each event colour. */
const COLOR_ID_BY_EVENT_COLOR: Record<CalendarEventColor, string> = {
  lavender: '1',
  sage: '2',
  grape: '3',
  flamingo: '4',
  banana: '5',
  tangerine: '6',
  peacock: '7',
  graphite: '8',
  blueberry: '9',
  basil: '10',
  tomato: '11'
}

const EVENT_COLOR_BY_COLOR_ID = new Map<string, CalendarEventColor>(
  CALENDAR_EVENT_COLORS.map((color) => [COLOR_ID_BY_EVENT_COLOR[color], color])
)

const CALENDAR_COLOR_BY_LEGACY_HEX = new Map<string, CalendarColor>(
  CALENDAR_COLORS.map((color, index) => [LEGACY_CALENDAR_HEX[index], color])
)

const HEX_COLOR = /^#[0-9a-f]{6}$/

export function calendarEventColorFromColorId(
  colorId: string | null | undefined
): CalendarEventColor | null {
  return colorId ? (EVENT_COLOR_BY_COLOR_ID.get(colorId) ?? null) : null
}

export function colorIdForCalendarEventColor(color: CalendarEventColor | null): string | null {
  return color ? COLOR_ID_BY_EVENT_COLOR[color] : null
}

export function calendarColorHex(color: CalendarColor): string {
  return CALENDAR_COLOR_HEX[color]
}

/**
 * The hex to show for a calendar's stored colour (Google `backgroundColor`).
 * A palette colour reads as Google's current hex for it, a custom colour the
 * user picked in Google reads as itself, and anything else as no colour.
 */
export function calendarDisplayHex(storedColor: string | null | undefined): string | null {
  const hex = storedColor?.trim().toLowerCase()
  if (!hex || !HEX_COLOR.test(hex)) return null
  const paletteColor = CALENDAR_COLOR_BY_LEGACY_HEX.get(hex)
  return paletteColor ? CALENDAR_COLOR_HEX[paletteColor] : hex
}
