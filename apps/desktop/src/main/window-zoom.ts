/**
 * The single owner of whole-UI zoom.
 *
 * Every write to `webContents.zoomFactor` goes through here. Two mechanisms
 * mutating it independently is how a persisted value drifts from what the user
 * actually sees, which is why the View menu's built-in `zoomIn`/`zoomOut`/
 * `resetZoom` roles were replaced rather than kept alongside this.
 *
 * Sits next to window-bounds.ts because it is the same class of setting: a
 * property of the display, persisted per install rather than per vault.
 */

import { BrowserWindow } from 'electron'
import { clampZoomFactor, UiZoomChannels, type ZoomFactor } from '@memry/contracts/ui-zoom'
import { getUiZoomFactor, setUiZoomFactor } from './store'
import { broadcastToAllWindows } from './lib/window-broadcast'
import { createLogger } from './lib/logger'

const logger = createLogger('WindowZoom')

/**
 * Windows that follow the setting.
 *
 * Membership is established by the one call that applies zoom at creation, so
 * the windows that must never scale — the splash and error screens (hand-rolled
 * `data:` HTML at fixed pixel sizes) and the headless PDF-export window — opt
 * out by simply not calling it, instead of being re-listed in every fan-out.
 */
const zoomedWindows = new WeakSet<BrowserWindow>()

/** The zoom factor every registered window should currently be at. */
export function getZoomFactor(): ZoomFactor {
  return getUiZoomFactor()
}

/**
 * Put `win` at the persisted zoom and keep it in step with later changes.
 *
 * Applied per window rather than left to Chromium: its default zoom mode is
 * per-origin, and every window here shares one origin (`file://` in a packaged
 * build, the dev server otherwise), so relying on implicit propagation would
 * behave differently in dev and in production. Idempotent, so callers may
 * re-apply on every load.
 */
export function applyZoomToWindow(win: BrowserWindow): void {
  zoomedWindows.add(win)
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.setZoomFactor(getZoomFactor())
  } catch (err) {
    logger.warn('Failed to apply zoom to a window:', err)
  }
}

/**
 * Persist `factor`, apply it everywhere, and tell the renderers.
 *
 * Returns the factor actually applied, which is `factor` snapped to the ladder.
 */
export function setZoomFactor(factor: number): ZoomFactor {
  const applied = clampZoomFactor(factor)
  setUiZoomFactor(applied)

  for (const win of BrowserWindow.getAllWindows()) {
    if (zoomedWindows.has(win)) applyZoomToWindow(win)
  }

  broadcastToAllWindows(UiZoomChannels.events.CHANGED, { factor: applied })
  logger.info(`UI zoom set to ${applied}`)
  return applied
}
