import { app, Menu, nativeImage, Tray, type BrowserWindow, type NativeImage } from 'electron'
import { createLogger } from './lib/logger'
import { getMainI18n } from './lib/main-i18n'
import { TRAY_ICON_BASE64, TRAY_ICON_TEMPLATE_BASE64 } from './tray-icon'

const logger = createLogger('Tray')

interface TrayDeps {
  getMainWindow: () => BrowserWindow | null
}

let tray: Tray | null = null
let enabled = false
let quitting = false
let getMainWindow: TrayDeps['getMainWindow'] = () => null
let quitListenerRegistered = false

function buildIcon(): NativeImage {
  if (process.platform === 'darwin') {
    const image = nativeImage
      .createFromDataURL(`data:image/png;base64,${TRAY_ICON_TEMPLATE_BASE64}`)
      .resize({ width: 16, height: 16 })
    image.setTemplateImage(true)
    return image
  }
  return nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`)
}

export function showMainWindow(): void {
  const window = getMainWindow()
  if (!window || window.isDestroyed()) return

  if (process.platform !== 'darwin') window.setSkipTaskbar(false)
  window.show()
  if (window.isMinimized()) window.restore()
  window.focus()
}

function buildContextMenu(): Menu {
  const t = getMainI18n().getFixedT(null, 'menu')
  return Menu.buildFromTemplate([
    { label: t('tray.show'), click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: process.platform === 'win32' ? t('app.exit') : t('app.quit'),
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
}

function createTray(): void {
  const menu = buildContextMenu()
  const instance = new Tray(buildIcon())
  instance.setToolTip(app.name)

  switch (process.platform) {
    case 'darwin':
      // No setContextMenu on macOS: it makes a left click open the menu, which
      // would leave no click that restores the window.
      instance.on('click', () => showMainWindow())
      instance.on('right-click', () => instance.popUpContextMenu(menu))
      break
    case 'win32':
      instance.setContextMenu(menu)
      instance.on('click', () => showMainWindow())
      break
    default:
      // Linux tray hosts do not reliably deliver click events, so the menu is
      // the only affordance that is guaranteed to work.
      instance.setContextMenu(menu)
      break
  }

  tray = instance
}

export function initTray(deps: TrayDeps): void {
  getMainWindow = deps.getMainWindow

  if (quitListenerRegistered) return
  quitListenerRegistered = true
  app.on('before-quit', () => {
    quitting = true
    // Windows leaves a ghost icon in the notification area until the user
    // hovers it if the process exits with a live Tray, and the shutdown
    // sequence ends in app.exit().
    destroyTray()
  })
}

/**
 * Converge on the requested state. Safe to call repeatedly — startup, a local
 * settings write and an inbound sync of the same value all land here.
 */
export function applyTraySetting(next: boolean): void {
  enabled = next

  if (enabled) {
    if (tray) return
    try {
      createTray()
      logger.info('tray created')
    } catch (err) {
      // Most likely a Linux session with no StatusNotifier host. The setting
      // stays on and keeps syncing; shouldHideOnClose() reports false, so the
      // window keeps its normal close behavior instead of vanishing with no way
      // to get it back.
      tray = null
      logger.warn('tray unavailable, close-to-tray disabled on this machine:', err)
    }
    return
  }

  if (!tray) return
  destroyTray()
  // A window hidden under the old setting would otherwise be unreachable.
  showMainWindow()
}

/**
 * Never intercept a close without a live tray: hiding the window when nothing
 * can bring it back leaves the user with a running app they cannot see or quit.
 */
export function shouldHideOnClose(): boolean {
  return enabled && isTrayActive() && !quitting
}

/** Whether a window hidden by this module can currently be brought back. */
export function isTrayActive(): boolean {
  return tray !== null
}

export function handleMainWindowClose(event: Electron.Event, window: BrowserWindow): void {
  if (!shouldHideOnClose()) return

  event.preventDefault()
  window.hide()
  if (process.platform !== 'darwin') window.setSkipTaskbar(true)
}

export function destroyTray(): void {
  if (!tray) return
  tray.destroy()
  tray = null
  logger.info('tray destroyed')
}

export function __resetTrayForTests(): void {
  tray = null
  enabled = false
  quitting = false
  quitListenerRegistered = false
  getMainWindow = () => null
}
