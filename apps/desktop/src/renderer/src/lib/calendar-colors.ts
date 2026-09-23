import type { CSSProperties } from 'react'

/** Share of the colour in a resting chip's fill; the rest is --background. */
export const CALENDAR_COLOR_FILL_PERCENT = 20

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
 * A coloured item's chip. At rest the colour tints the chip and the title
 * keeps the theme's ink; selected, the chip goes solid.
 */
export function calendarColorChipStyle(hex: string, isSelected: boolean): CSSProperties {
  return isSelected
    ? { backgroundColor: hex, color: inkOnCalendarColor(hex) }
    : {
        backgroundColor: `color-mix(in srgb, ${hex} ${CALENDAR_COLOR_FILL_PERCENT}%, var(--background))`,
        color: 'var(--foreground)'
      }
}
