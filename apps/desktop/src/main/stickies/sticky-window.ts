/**
 * The sticky window, opened by its own system-wide shortcut (Quick Capture
 * has another). It opens on a draft (the latest one, or the one the edge tab
 * unfolds) or blank, and tucking it away closes it while its draft stays,
 * shown by the edge tab.
 *
 * @module main/stickies/sticky-window
 */

import { BrowserWindow, screen } from 'electron'
import {
  StickyChannels,
  type StickyOpenTargetInput,
  type StickyWindowSession
} from '@memry/contracts/sticky-api'
import { createLogger } from '../lib/logger'
import { listStickyDrafts } from './drafts'
import { refreshEdgeTab } from './edge-tab'
import { loadRendererRoute, STICKY_PRELOAD_PATH } from './renderer-route'

const log = createLogger('StickyWindow')

/** The card plus the transparent margin its shadow draws into. */
const WINDOW_WIDTH = 360
const INITIAL_HEIGHT = 230
const MIN_HEIGHT = 140
const MAX_HEIGHT = 560

let stickyWindow: BrowserWindow | null = null
let session: StickyWindowSession = { draftId: null }

export function getStickyWindow(): BrowserWindow | null {
  return stickyWindow && !stickyWindow.isDestroyed() ? stickyWindow : null
}

export function isStickyWindowOpen(): boolean {
  return getStickyWindow() !== null
}

export function getStickyWindowSession(): StickyWindowSession {
  return session
}

/** Near the cursor, on the display it is on, kept inside that display's work area. */
function placeNearCursor(): { x: number; y: number } {
  const cursor = screen.getCursorScreenPoint()
  const area = screen.getDisplayNearestPoint(cursor).workArea
  const x = Math.round(cursor.x - WINDOW_WIDTH / 2)
  const y = Math.round(cursor.y - 60)
  return {
    x: Math.min(Math.max(x, area.x), area.x + area.width - WINDOW_WIDTH),
    y: Math.min(Math.max(y, area.y), area.y + area.height - INITIAL_HEIGHT)
  }
}

/**
 * Open the sticky. `draftId` undefined resumes the latest draft (the global
 * shortcut); null starts blank; an id opens that draft. An open sticky on
 * another draft is replaced, since it saved as it went.
 */
export function showStickyWindow(draftId?: string | null): void {
  const next = draftId === undefined ? (listStickyDrafts()[0]?.id ?? null) : draftId
  const open = getStickyWindow()
  if (open) {
    if (draftId === undefined || next === session.draftId) {
      open.focus()
      return
    }
    open.destroy()
  }

  session = { draftId: next }
  const { x, y } = placeNearCursor()
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: INITIAL_HEIGHT,
    x,
    y,
    alwaysOnTop: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: STICKY_PRELOAD_PATH,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  stickyWindow = window
  // The edge tab stands for the drafts while the sticky is away.
  refreshEdgeTab()

  loadRendererRoute(window.webContents, 'sticky')

  window.once('ready-to-show', () => {
    window.show()
    window.focus()
  })

  window.on('closed', () => {
    if (stickyWindow === window) stickyWindow = null
    refreshEdgeTab()
  })
}

/**
 * Close the sticky. Its renderer saved the draft before asking, so nothing is
 * lost; the edge tab shows when drafts remain. The window is forgotten before
 * it finishes closing, so a shortcut in between opens a new one instead of
 * focusing the one on its way out.
 */
export function tuckStickyWindow(): void {
  const window = getStickyWindow()
  if (!window) return
  stickyWindow = null
  window.close()
}

export function resizeStickyWindow(height: number): void {
  const window = getStickyWindow()
  if (!window) return
  const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)))
  window.setSize(WINDOW_WIDTH, clamped)
}

/** The app window: any live BrowserWindow that is not the sticky. */
function findMainWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find((win) => win !== stickyWindow && !win.isDestroyed()) ?? null
  )
}

function revealMainWindow(): BrowserWindow | null {
  const mainWindow = findMainWindow()
  if (!mainWindow) {
    log.warn('No app window to reveal from the sticky')
    return null
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  return mainWindow
}

export function openStickyTargetInMainWindow(target: StickyOpenTargetInput): void {
  revealMainWindow()?.webContents.send(StickyChannels.events.OPEN_TARGET_REQUESTED, target)
  tuckStickyWindow()
}
