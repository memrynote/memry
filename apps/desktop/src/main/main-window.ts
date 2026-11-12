/**
 * The app window, held by reference. `BrowserWindow.getAllWindows()` also lists
 * the sticky, Quick Capture and the startup splash and error windows, so "the
 * first live window" can be one of those.
 *
 * @module main/main-window
 */

import type { BrowserWindow } from 'electron'

let mainWindow: BrowserWindow | null = null

export function setMainWindow(window: BrowserWindow): void {
  mainWindow = window
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}
