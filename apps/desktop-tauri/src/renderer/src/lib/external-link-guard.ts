import { commands } from '../../../generated/bindings'
import { createLogger } from './logger'

const log = createLogger('ExternalLinks')

/**
 * Why the window never navigates itself: the shell refuses a main-frame navigation off the app
 * (`shell::navigation_guard`), but on WebKitGTK only after the page's `beforeunload` ran and its
 * in-flight requests were cancelled; Tauri resends an aborted `ipc://` command, so it can run
 * twice. So the app opens the links it is given itself, before the engine starts a navigation:
 * clicked links and links dropped on it here, and app code never assigns `location` (the
 * `memry/no-location-navigation` lint). A `mailto:` link starts no load on WebKitGTK at all.
 *
 * Both listeners sit on `window` in the capture phase, installed before the app renders, so they
 * run before every handler of the app: one that stops propagation cannot hide a link from them.
 * They stop the engine's default action at once and open the link after the dispatch, unless a
 * later handler claimed the event with `preventDefault` (the editor, a drop zone that takes a URL).
 * Those handlers see `defaultPrevented` exactly as they would without this guard.
 */

interface CaptureHost<K extends 'click' | 'dragenter' | 'dragover' | 'drop', E extends Event> {
  addEventListener(type: K, listener: (event: E) => void, capture: true): void
  removeEventListener(type: K, listener: (event: E) => void, capture: true): void
}

/** `URL.parse` is too new for the oldest WKWebView the app supports. */
function parseUrl(href: string): URL | null {
  try {
    return new URL(href)
  } catch {
    return null
  }
}

const OPENED = new Set(['http:', 'https:', 'mailto:'])

/**
 * Cancels the event's default action now and runs `unclaimed` after the dispatch when no later
 * handler called `preventDefault`. Later handlers read `defaultPrevented` as true only once one of
 * them claimed the event.
 */
function preventUnlessClaimed(event: Event, unclaimed: () => void): void {
  let claimed = false
  const prevent = event.preventDefault.bind(event)
  Object.defineProperty(event, 'preventDefault', {
    configurable: true,
    value: () => {
      claimed = true
      prevent()
    }
  })
  Object.defineProperty(event, 'defaultPrevented', { configurable: true, get: () => claimed })
  prevent()
  setTimeout(() => {
    if (!claimed) unclaimed()
  }, 0)
}

/** Sends a clicked web or mail link to the OS and keeps the page where it is. Returns the cleanup. */
export function watchExternalLinks(
  host: CaptureHost<'click', MouseEvent>,
  open: (url: string) => Promise<unknown>,
  origin: string
): () => void {
  const onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return
    const anchor = event.target.closest('a[href]')
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) return
    const url = parseUrl(anchor.href)
    if (!url || url.origin === origin || !OPENED.has(url.protocol)) return
    preventUnlessClaimed(event, () => {
      open(url.href).catch((error: unknown) => log.warn('a link did not open', error))
    })
  }
  host.addEventListener('click', onClick, true)
  return () => host.removeEventListener('click', onClick, true)
}

const EDITABLE = 'input, textarea, [contenteditable], .ProseMirror'

/** A link dragged in from a browser, over a part of the app that takes no text. */
function isLinkDrag(event: DragEvent): boolean {
  const types = event.dataTransfer?.types ?? []
  if (!types.includes('text/uri-list') || types.includes('Files')) return false
  return !(event.target instanceof Element && event.target.closest(EDITABLE))
}

/**
 * WebKit fires `drop` only when the last `dragenter` or `dragover` was cancelled (entering a new
 * element it takes the answer from `dragenter`); otherwise it loads the dragged URL.
 */
function acceptLinkDrag(event: DragEvent): void {
  if (event.defaultPrevented || !isLinkDrag(event)) return
  preventUnlessClaimed(event, () => undefined)
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'link'
}

/**
 * Takes a link dragged in from a browser and dropped outside the editor and the text fields, and
 * opens it in the OS. A file drop (which carries `Files` as well) belongs to the file-drop zones.
 * Returns the cleanup.
 */
export function watchLinkDrops(
  host: CaptureHost<'dragenter' | 'dragover' | 'drop', DragEvent>,
  open: (url: string) => Promise<unknown>
): () => void {
  const onDrop = (event: DragEvent): void => {
    if (event.defaultPrevented || !isLinkDrag(event)) return
    const first = (event.dataTransfer?.getData('text/uri-list') ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('#'))
    const url = first ? parseUrl(first) : null
    preventUnlessClaimed(event, () => {
      if (!url || !OPENED.has(url.protocol)) return
      open(url.href).catch((error: unknown) => log.warn('a dropped link did not open', error))
    })
  }
  host.addEventListener('dragenter', acceptLinkDrag, true)
  host.addEventListener('dragover', acceptLinkDrag, true)
  host.addEventListener('drop', onDrop, true)
  return () => {
    host.removeEventListener('dragenter', acceptLinkDrag, true)
    host.removeEventListener('dragover', acceptLinkDrag, true)
    host.removeEventListener('drop', onDrop, true)
  }
}

const openInOs = (url: string): Promise<unknown> => commands.shellOpenExternal(url)

/** Installed before the app renders (`main.tsx`), so its listeners run first. */
export function installExternalLinkGuard(): () => void {
  const stopLinks = watchExternalLinks(window, openInOs, window.location.origin)
  const stopDrops = watchLinkDrops(window, openInOs)
  return () => {
    stopLinks()
    stopDrops()
  }
}
