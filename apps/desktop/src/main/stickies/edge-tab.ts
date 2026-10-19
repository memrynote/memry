/**
 * The edge tab: a small tab on the screen edge that stands for the unsent
 * drafts while the sticky is closed. Hovering it fans out the draft list;
 * clicking a draft unfolds the sticky on it.
 *
 * It is a BaseWindow holding a WebContentsView, not a BrowserWindow, on
 * purpose: it stays out of `BrowserWindow.getAllWindows()`, which many callers
 * read as "the app window" (and the Dock `activate` handler reads as "is there
 * a window"). A BaseWindow still counts for `window-all-closed`, so on Windows
 * and Linux the tab closes with the last app window and the app quits as
 * before.
 *
 * @module main/stickies/edge-tab
 */

import { app, BaseWindow, BrowserWindow, screen, WebContentsView, type Rectangle } from 'electron'
import { StickyChannels } from '@memry/contracts/ipc-channels'
import { createLogger } from '../lib/logger'
import { getStickySettings } from '../settings/sticky-settings'
import { listStickyDrafts } from './drafts'
import { loadRendererRoute, STICKY_PRELOAD_PATH } from './renderer-route'

const log = createLogger('StickyEdgeTab')

/** The tab plus room for its shadow. */
const COLLAPSED = { width: 44, height: 84 }
const PEEK_WIDTH = 300
const PEEK_ROW_HEIGHT = 52
const PEEK_CHROME_HEIGHT = 64
const PEEK_MAX_ROWS = 5

let tabWindow: BaseWindow | null = null
let tabView: WebContentsView | null = null
let workArea: Rectangle | null = null
let peeking = false
let isStickyOpen: () => boolean = () => false

export function setEdgeTabStickyProbe(probe: () => boolean): void {
  isStickyOpen = probe
}

/** Whether any app window is alive; without one, Windows and Linux quit. */
function hasAppWindow(): boolean {
  return BrowserWindow.getAllWindows().some((win) => !win.isDestroyed())
}

function shouldShow(): boolean {
  if (isStickyOpen()) return false
  if (process.platform !== 'darwin' && !hasAppWindow()) return false
  return listStickyDrafts().length > 0
}

function boundsFor(area: Rectangle, size: { width: number; height: number }): Rectangle {
  const edge = getStickySettings().tuckEdge
  const x = edge === 'left' ? area.x : area.x + area.width - size.width
  // The tab's top stays put when the list fans out below it.
  const y = Math.round(area.y + area.height * 0.32)
  return { x, y, width: size.width, height: Math.min(size.height, area.y + area.height - y) }
}

function applyBounds(): void {
  if (!tabWindow || !tabView || !workArea) return
  const rows = Math.min(listStickyDrafts().length, PEEK_MAX_ROWS)
  const size = peeking
    ? { width: PEEK_WIDTH, height: PEEK_CHROME_HEIGHT + rows * PEEK_ROW_HEIGHT }
    : COLLAPSED
  const bounds = boundsFor(workArea, size)
  tabWindow.setBounds(bounds)
  tabView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
}

function createTab(): void {
  workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  peeking = false
  const window = new BaseWindow({
    ...boundsFor(workArea, COLLAPSED),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false
  })
  window.setAlwaysOnTop(true, 'floating')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const view = new WebContentsView({
    webPreferences: {
      preload: STICKY_PRELOAD_PATH,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  view.setBackgroundColor('#00000000')
  window.contentView.addChildView(view)
  tabWindow = window
  tabView = view
  applyBounds()

  loadRendererRoute(view.webContents, 'sticky-tab')
  view.webContents.once('did-finish-load', () => {
    if (tabWindow === window) window.showInactive()
  })
  window.on('closed', () => {
    if (tabWindow !== window) return
    tabWindow = null
    tabView = null
    view.webContents.close()
  })
}

function closeTab(): void {
  const window = tabWindow
  if (!window) return
  tabWindow = null
  const view = tabView
  tabView = null
  window.destroy()
  view?.webContents.close()
}

/** Show, update or close the tab to match the drafts and the sticky. */
export function refreshEdgeTab(): void {
  try {
    if (!shouldShow()) {
      closeTab()
      return
    }
    if (!tabWindow) {
      createTab()
      return
    }
    applyBounds()
    tabView?.webContents.send(StickyChannels.events.DRAFTS_CHANGED, {})
  } catch (err) {
    log.error('Edge tab refresh failed', err)
  }
}

/** Fan the draft list out on hover, and fold it back. */
export function setEdgeTabPeek(open: boolean): void {
  if (peeking === open) return
  peeking = open
  applyBounds()
}

/**
 * On Windows and Linux the app quits with its last window. The tab must not
 * keep it running, so it closes when the last app window does.
 */
export function closeEdgeTabWithLastAppWindow(): void {
  app.on('browser-window-created', (_event, created) => {
    created.once('closed', () => {
      if (process.platform !== 'darwin' && !hasAppWindow()) closeTab()
    })
  })
}
