/**
 * Interface Font Size
 *
 * The root font size the interface renders at, as a pixel value, plus the
 * mapping to and from the legacy small/medium/large enum.
 *
 * @module contracts/font-size
 */

export const FONT_SIZE_PX_MIN = 12
export const FONT_SIZE_PX_MAX = 24
export const FONT_SIZE_PX_DEFAULT = 16

/** The pixel value each legacy bucket rendered at before the slider existed. */
export const LEGACY_FONT_SIZE_PX = { small: 14, medium: 16, large: 20 } as const

export type LegacyFontSize = keyof typeof LEGACY_FONT_SIZE_PX

const LEGACY_ENTRIES = Object.entries(LEGACY_FONT_SIZE_PX) as [LegacyFontSize, number][]

export function resolveFontSizePx(
  fontSizePx: number | undefined,
  fontSize: string | undefined
): number {
  if (typeof fontSizePx === 'number' && Number.isFinite(fontSizePx)) {
    // Rounded, not just clamped: both schemas declare this field `.int()`, and
    // readPreferences never parses through them, so a hand-edited 16.4 in
    // config.json would otherwise reach the root element and make every
    // step-1 arrow generate another fraction that never lands on a bucket.
    return Math.round(Math.min(FONT_SIZE_PX_MAX, Math.max(FONT_SIZE_PX_MIN, fontSizePx)))
  }
  const legacy = LEGACY_ENTRIES.find(([name]) => name === fontSize)
  return legacy ? legacy[1] : FONT_SIZE_PX_DEFAULT
}

export function toLegacyFontSize(px: number): LegacyFontSize {
  // Strict `<` keeps the first of two equally near buckets, and the table is
  // ascending, so a midpoint resolves to the smaller size.
  return LEGACY_ENTRIES.reduce(
    (best, [name, bucketPx]) =>
      Math.abs(bucketPx - px) < Math.abs(LEGACY_FONT_SIZE_PX[best] - px) ? name : best,
    LEGACY_ENTRIES[0][0]
  )
}
