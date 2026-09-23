import type { CSSProperties } from 'react'
import type { CalendarProjectionItem } from '@/services/calendar-service'

type VisualType = CalendarProjectionItem['visualType']

/** The six calendar hues. Their per-theme values live in base.css as `--cal-<hue>-*`. */
export const EVENT_HUES = ['indigo', 'violet', 'green', 'cyan', 'amber', 'pink'] as const
export type EventHue = (typeof EVENT_HUES)[number]

/**
 * Each item type owns one hue. `note_date` shares the note hue and is told
 * apart by its dashed outline, not by a seventh colour.
 */
export const EVENT_TYPE_HUES: Record<VisualType, EventHue> = {
  event: 'indigo',
  external_event: 'violet',
  task: 'green',
  reminder: 'cyan',
  snooze: 'amber',
  note: 'pink',
  note_date: 'pink'
}

/**
 * Light-theme rail hex per type, for places that need a literal colour rather
 * than a theme token: dots, swatches, borders drawn outside a chip. The rails
 * are saturated enough to read on the dark canvas as well.
 */
const HUE_RAIL_HEX: Record<EventHue, string> = {
  indigo: '#3E63DD',
  violet: '#8E4EC6',
  green: '#30A46C',
  cyan: '#00A2C7',
  amber: '#F5A524',
  pink: '#D6409F'
}

export const EVENT_TYPE_COLORS: Record<VisualType, string> = {
  event: HUE_RAIL_HEX.indigo,
  external_event: HUE_RAIL_HEX.violet,
  task: HUE_RAIL_HEX.green,
  reminder: HUE_RAIL_HEX.cyan,
  snooze: HUE_RAIL_HEX.amber,
  note: HUE_RAIL_HEX.pink,
  note_date: HUE_RAIL_HEX.pink
}

export function getEventBaseColor(type: VisualType): string {
  return EVENT_TYPE_COLORS[type]
}

/**
 * Custom properties a calendar chip paints itself with. Both the item-type
 * palette and a Google/event colour resolve to this one shape, so the chip has
 * a single rendering path:
 *
 * --chip-rail        rail colour
 * --chip-surface     resting fill
 * --chip-meta        time/duration text on the surface
 * --chip-solid       fill while selected
 * --chip-solid-ink   text on the solid fill
 */
export type ChipColorVars = CSSProperties & Record<`--chip-${string}`, string>

export function eventTypeChipVars(type: VisualType): ChipColorVars {
  const hue = EVENT_TYPE_HUES[type]
  return {
    '--chip-rail': `var(--cal-${hue}-rail)`,
    '--chip-surface': `var(--cal-${hue}-surface)`,
    '--chip-meta': `var(--cal-${hue}-meta)`,
    '--chip-solid': `var(--cal-${hue}-solid)`,
    '--chip-solid-ink': `var(--cal-${hue}-solid-ink)`
  }
}
