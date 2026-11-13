import { BrowserWindow, ipcMain, nativeTheme, type BrowserWindowConstructorOptions } from 'electron'
import { AppChannels } from '@memry/contracts/ipc-channels'
import { clampZoomFactor } from '@memry/contracts/app-zoom'
import { createLogger } from './lib/logger'

const logger = createLogger('TitleBarOverlay')

/** Matches the renderer's h-9 title row at 100% zoom. */
export const TITLE_BAR_HEIGHT_PX = 36

// Transparent so the caption buttons sit on Memry's own chrome, whatever the theme.
const OVERLAY_COLOR = '#00000000'

// Only hex, the format the renderer sends. Anything else is ignored rather than
// handed to Electron's color parser.
const HEX_COLOR = /^#[0-9a-f]{6}$/i

/**
 * Frame options for the main window, per platform.
 * - macOS: hidden title bar, native traffic lights centered in the title row.
 * - Windows: hidden title bar, native caption buttons drawn over the title row
 *   (Window Controls Overlay). The renderer reserves their width through the
 *   `titlebar-area-*` CSS env variables.
 * - Linux: native frame. titleBarOverlay depends on the window manager there
 *   (and Electron draws its own buttons), so it stays opt-out for now.
 */
export function getMainWindowFrameOptions(
  platform: NodeJS.Platform,
  prefersDark: () => boolean = () => nativeTheme.shouldUseDarkColors
): Partial<BrowserWindowConstructorOptions> {
  if (platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 12 } }
  }
  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: OVERLAY_COLOR,
        // First paint only; the renderer sends the theme's color once it loads.
        symbolColor: prefersDark() ? '#e5e5e5' : '#3f3f3f',
        height: TITLE_BAR_HEIGHT_PX
      }
    }
  }
  return {}
}

/**
 * The title row is 36 CSS px, so page zoom scales it, while the native overlay
 * height is in unzoomed DIPs. Without this the caption buttons outgrow the row
 * below 100% and fall short of it above.
 */
export function titleBarHeightForZoom(zoomFactor: number): number {
  return Math.round(TITLE_BAR_HEIGHT_PX * clampZoomFactor(zoomFactor))
}

export function registerTitleBarOverlayIpc(): void {
  if (process.platform !== 'win32') return
  ipcMain.on(AppChannels.send.TITLE_BAR_SYMBOL_COLOR, (event, color: unknown) => {
    if (typeof color !== 'string' || !HEX_COLOR.test(color)) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    try {
      win.setTitleBarOverlay({ color: OVERLAY_COLOR, symbolColor: color })
    } catch (err) {
      // Throws for windows created without an overlay (splash, quick capture).
      logger.debug('setTitleBarOverlay skipped:', err)
    }
  })
  ipcMain.on(AppChannels.send.TITLE_BAR_ZOOM_FACTOR, (event, zoomFactor: unknown) => {
    if (typeof zoomFactor !== 'number') return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    try {
      win.setTitleBarOverlay({ height: titleBarHeightForZoom(zoomFactor) })
    } catch (err) {
      logger.debug('setTitleBarOverlay skipped:', err)
    }
  })
}
