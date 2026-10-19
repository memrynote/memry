import { join } from 'path'
import { app, type WebContents } from 'electron'
import { createLogger } from '../lib/logger'

const log = createLogger('StickyRoute')

export const STICKY_PRELOAD_PATH = join(__dirname, '../preload/index.js')

/**
 * Load a hash route of the renderer entry: the Vite dev server in dev, the
 * built file otherwise. main.tsx picks the window's root from the hash.
 */
export function loadRendererRoute(webContents: WebContents, route: string): void {
  webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log.error('failed to load:', route, errorCode, errorDescription)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    const baseUrl = devUrl.endsWith('/') ? devUrl.slice(0, -1) : devUrl
    void webContents.loadURL(`${baseUrl}/#/${route}`)
    return
  }
  void webContents.loadFile(join(__dirname, '../renderer/index.html'), { hash: route })
}
