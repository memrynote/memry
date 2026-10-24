import { clampZoomFactor, ZOOM_FACTOR_DEFAULT } from '@memry/contracts/app-zoom'
import { readStartupState } from './state'

export const ZOOM_STORAGE_KEY = 'memry-zoom-factor'

export function getStartupZoomFactor(): number {
  const fromState = readStartupState()?.zoom
  if (typeof fromState === 'number' && Number.isFinite(fromState)) {
    return clampZoomFactor(fromState)
  }
  try {
    const cached = window.localStorage.getItem(ZOOM_STORAGE_KEY)
    // parseFloat, not Number: `Number('')` is 0, which clamps to the minimum and would shrink
    // the interface instead of leaving it at 100%.
    if (cached !== null) return clampZoomFactor(Number.parseFloat(cached))
  } catch {
    // localStorage may be unavailable in restricted environments
  }
  return ZOOM_FACTOR_DEFAULT
}

/** Writes the cache only. The native zoom of the webview is Step 10 (#3527). */
export function applyStartupZoom(): void {
  try {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, String(getStartupZoomFactor()))
  } catch {
    // Losing the cache only costs the next launch its head start
  }
}
