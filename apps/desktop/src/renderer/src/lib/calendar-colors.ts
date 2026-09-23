import type { ChipColorVars } from './event-type-colors'

/** Share of the colour in a resting chip's fill; the rest is --background. */
export const CALENDAR_COLOR_FILL_PERCENT = 25

/**
 * Share of the colour in a resting chip's time/duration text; the rest is
 * --cal-ink. Low enough that the text clears AA on the tinted fill for every
 * Google colour and the custom extremes, high enough to keep the hue.
 */
export const CALENDAR_COLOR_META_PERCENT = 35

const DARK_INK = '#000000'
const LIGHT_INK = '#ffffff'

function relativeLuminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/**
 * Title ink for text on a solid `#rrggbb` fill: black or white, whichever
 * contrasts more. Google colours run from Banana to Blueberry and a custom
 * calendar colour can be anything, so no single ink reads on all. Pure black
 * and white are the only pair that keep every fill at 4.5:1 or better.
 */
export function inkOnCalendarColor(hex: string): string {
  const fill = relativeLuminance(hex)
  const lightInkContrast = (relativeLuminance(LIGHT_INK) + 0.05) / (fill + 0.05)
  const darkInkContrast = (fill + 0.05) / (relativeLuminance(DARK_INK) + 0.05)
  return lightInkContrast >= darkInkContrast ? LIGHT_INK : DARK_INK
}

/**
 * Chip colour variables for an item with its own `#rrggbb` (an event colour or
 * its Google calendar's colour). Same shape as `eventTypeChipVars`: the colour
 * is the rail, a tint of it is the surface, the title keeps --cal-ink, and the
 * chip goes solid when selected.
 */
export function calendarColorChipVars(hex: string): ChipColorVars {
  return {
    '--chip-rail': hex,
    '--chip-surface': `color-mix(in srgb, ${hex} ${CALENDAR_COLOR_FILL_PERCENT}%, var(--background))`,
    '--chip-meta': `color-mix(in srgb, ${hex} ${CALENDAR_COLOR_META_PERCENT}%, var(--cal-ink))`,
    '--chip-solid': hex,
    '--chip-solid-ink': inkOnCalendarColor(hex)
  }
}
