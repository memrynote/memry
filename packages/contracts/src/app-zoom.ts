/**
 * Application Zoom
 *
 * The factor the whole interface renders at, and the arithmetic that keeps
 * every reachable value on one of the slider's stops.
 *
 * @module contracts/app-zoom
 */

export const ZOOM_FACTOR_MIN = 0.5
export const ZOOM_FACTOR_MAX = 2
export const ZOOM_FACTOR_DEFAULT = 1
export const ZOOM_FACTOR_STEP = 0.1

export function clampZoomFactor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ZOOM_FACTOR_DEFAULT

  // The only tolerance point for this field: `readGroupSettings` merges the
  // parsed file over the defaults without ever running the Zod schema, so a
  // hand-edited config.json or a value from an older build reaches consumers
  // unvalidated.
  //
  // Snapped before it is clamped, and by rounding the tenths as an integer:
  // 0.1 is not exact in binary, so repeated stepping would otherwise drift off
  // the slider's stops and store values like 0.7000000000000001.
  const snapped = Math.round(value * 10) / 10
  return Math.min(ZOOM_FACTOR_MAX, Math.max(ZOOM_FACTOR_MIN, snapped))
}

export function stepZoomFactor(current: number, direction: 1 | -1): number {
  return clampZoomFactor(clampZoomFactor(current) + direction * ZOOM_FACTOR_STEP)
}

export function zoomPercent(factor: number): number {
  return Math.round(factor * 100)
}
