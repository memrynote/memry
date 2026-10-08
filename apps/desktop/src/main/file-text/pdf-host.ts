/**
 * PDF reading for the main process, in a WebContentsView that is never shown.
 *
 * Node has no canvas, so a page can only be rendered where Chromium is. The
 * view is not a BrowserWindow on purpose: it stays out of
 * `BrowserWindow.getAllWindows()`, which many callers read as "the app window",
 * and it never holds `window-all-closed` open. It loads the renderer entry
 * `pdf-host.html` and is driven through `executeJavaScript`, so it needs no
 * preload and no IPC channel. It closes itself a minute after its last document.
 *
 * Text extraction and the agent vision tool (FB-002) both read pages here:
 * `openPdfDocument(path, size)`, then `renderPage(page, maxEdge)` per page.
 */
import { app, WebContentsView, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import path from 'path'
import { createLogger } from '../lib/logger'
import { toMemryFileUrl } from '../lib/paths'
import { lowerProcessPriority } from './low-priority'

const logger = createLogger('PdfHost')

const CALL_TIMEOUT_MS = 120_000
const IDLE_CLOSE_MS = 60_000

export interface RenderedPdfPage {
  png: Uint8Array
  width: number
  height: number
}

export interface PdfDocument {
  readonly pageCount: number
  /** The page's text layer, empty for a scanned page. */
  pageText(pageNumber: number): Promise<string>
  /** The page as PNG, its long edge at most `maxEdge` px and never past 300 DPI. */
  renderPage(pageNumber: number, maxEdge: number): Promise<RenderedPdfPage>
  close(): Promise<void>
}

/**
 * Held here, not just in the load promise: a view that belongs to no window and
 * no live variable is garbage, and its page goes with it mid-load.
 */
let hostView: WebContentsView | null = null
let host: Promise<WebContents> | null = null
/** Bumped on every close, so a late crash event from an old view leaves a newer one alone. */
let generation = 0
const openDocuments = new Set<string>()
const inFlight = new Set<(error: Error) => void>()
let idleTimer: ReturnType<typeof setTimeout> | null = null

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

/** Close the view and fail every call still waiting on it. */
export function closePdfHost(): void {
  clearIdleTimer()
  generation++
  const closing = hostView
  hostView = null
  host = null
  openDocuments.clear()
  for (const fail of inFlight) fail(new Error('PDF host closed'))
  inFlight.clear()
  if (closing && !closing.webContents.isDestroyed()) closing.webContents.close()
}

async function loadHost(view: WebContentsView, owner: number): Promise<WebContents> {
  const contents = view.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.once('render-process-gone', (_event, details) => {
    logger.warn('PDF host renderer exited', { reason: details.reason })
    if (generation === owner) closePdfHost()
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    await contents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/pdf-host.html`)
  } else {
    await contents.loadFile(path.join(__dirname, '../renderer/pdf-host.html'))
  }
  lowerProcessPriority(contents.getOSProcessId())
  return contents
}

function getHost(): Promise<WebContents> {
  clearIdleTimer()
  if (!host) {
    const owner = generation
    hostView = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false
      }
    })
    host = loadHost(hostView, owner).catch((error: unknown) => {
      if (generation === owner) closePdfHost()
      throw error
    })
  }
  return host
}

async function call<T>(script: string): Promise<T> {
  const contents = await getHost()
  const owner = generation
  return new Promise<T>((resolve, reject) => {
    const fail = (error: Error): void => {
      clearTimeout(timer)
      inFlight.delete(fail)
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new Error('PDF host did not answer in time'))
      if (generation === owner) closePdfHost()
    }, CALL_TIMEOUT_MS)
    inFlight.add(fail)
    try {
      contents.executeJavaScript(script).then(
        (value: T) => {
          clearTimeout(timer)
          inFlight.delete(fail)
          resolve(value)
        },
        (error: unknown) => fail(toError(error))
      )
    } catch (error) {
      fail(toError(error))
    }
  })
}

/**
 * pdfjs exceptions are not real Errors, so a rejection crosses from the page as
 * a plain `{ name, message }` object. Keep its message.
 */
function toError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error
    if (typeof message === 'string' && message) return new Error(message)
  }
  return new Error(String(error))
}

/** `toMemryFileUrl` leaves these raw, and the protocol handler reads them as URL syntax. */
function encodedMemryFileUrl(absolutePath: string): string {
  return toMemryFileUrl(absolutePath).replace(/[%#?]/g, encodeURIComponent)
}

export async function openPdfDocument(absolutePath: string, size: number): Promise<PdfDocument> {
  const id = randomUUID()
  const handle = JSON.stringify(id)
  const pageCount = await call<number>(
    `window.memryPdfHost.open(${handle}, ${JSON.stringify(encodedMemryFileUrl(absolutePath))}, ${size})`
  )
  openDocuments.add(id)

  return {
    pageCount,
    pageText: (pageNumber) =>
      call<string>(`window.memryPdfHost.pageText(${handle}, ${pageNumber})`),
    renderPage: (pageNumber, maxEdge) =>
      call<RenderedPdfPage>(`window.memryPdfHost.renderPage(${handle}, ${pageNumber}, ${maxEdge})`),
    async close() {
      if (!openDocuments.delete(id)) return
      await call(`window.memryPdfHost.close(${handle})`).catch(() => {})
      if (openDocuments.size === 0 && host) {
        clearIdleTimer()
        idleTimer = setTimeout(closePdfHost, IDLE_CLOSE_MS)
      }
    }
  }
}
