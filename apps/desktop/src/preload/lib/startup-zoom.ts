import { ipcRenderer, webFrame } from 'electron'
import { AppChannels } from '@memry/contracts/ipc-channels'
import { clampZoomFactor, ZOOM_FACTOR_DEFAULT } from '@memry/contracts/app-zoom'

export const ZOOM_STORAGE_KEY = 'memry-zoom-factor'

export function getStartupZoomFactor(): number {
  try {
    const cached = window.localStorage.getItem(ZOOM_STORAGE_KEY)
    // parseFloat, not Number: `Number('')` is 0, which clamps to the minimum
    // and would shrink the interface instead of leaving it at 100%.
    if (cached !== null) return clampZoomFactor(Number.parseFloat(cached))
  } catch {
    // localStorage may be unavailable in some test or restricted environments
  }
  return ZOOM_FACTOR_DEFAULT
}

export function applyZoomFactor(factor: number): void {
  const zoomFactor = clampZoomFactor(factor)

  try {
    webFrame.setZoomFactor(zoomFactor)
  } catch {
    // webFrame is absent outside a real renderer (tests, restricted contexts)
  }

  // The Windows caption buttons are native and ignore page zoom, so main resizes
  // them to the zoomed title row (main/title-bar-overlay.ts).
  if (process.platform === 'win32') {
    ipcRenderer.send(AppChannels.send.TITLE_BAR_ZOOM_FACTOR, zoomFactor)
  }

  try {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, String(zoomFactor))
  } catch {
    // Losing the cache only costs the next launch its head start
  }
}
