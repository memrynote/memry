import { commands } from '../../../generated/bindings'
import { createLogger } from './logger'

const log = createLogger('ExternalLinks')

interface ClickHost {
  addEventListener(type: 'click', listener: (event: MouseEvent) => void): void
  removeEventListener(type: 'click', listener: (event: MouseEvent) => void): void
}

/** `URL.parse` is too new for the oldest WKWebView the app supports. */
function parseUrl(href: string): URL | null {
  try {
    return new URL(href)
  } catch {
    return null
  }
}

/**
 * Sends a clicked web or mail link to the OS and keeps the page where it is. The shell would send
 * it there too (`shell::navigation_guard` decides every main-frame navigation before it commits),
 * but on WebKitGTK only after the page's `beforeunload` ran and its in-flight requests were
 * cancelled, and a `mailto:` link starts no load there for the shell to see. It runs after the handlers of the editor and the components, which
 * claim their own links with `preventDefault`. Returns the cleanup.
 */
export function watchExternalLinks(
  host: ClickHost,
  open: (url: string) => Promise<unknown>,
  origin: string
): () => void {
  const onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return
    const anchor = event.target.closest('a[href]')
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) return
    const url = parseUrl(anchor.href)
    if (!url) return
    if (url.origin === origin || !['http:', 'https:', 'mailto:'].includes(url.protocol)) return
    event.preventDefault()
    open(url.href).catch((error: unknown) => log.warn('a link did not open', error))
  }
  host.addEventListener('click', onClick)
  return () => host.removeEventListener('click', onClick)
}

interface DropHost {
  addEventListener(type: 'dragover' | 'drop', listener: (event: DragEvent) => void): void
  removeEventListener(type: 'dragover' | 'drop', listener: (event: DragEvent) => void): void
}

const EDITABLE = 'input, textarea, [contenteditable], .ProseMirror'

/** A link dragged in from a browser, over a part of the app that takes no text. */
function isLinkDrag(event: DragEvent): boolean {
  const types = event.dataTransfer?.types ?? []
  if (!types.includes('text/uri-list') || types.includes('Files')) return false
  return !(event.target instanceof Element && event.target.closest(EDITABLE))
}

function acceptLinkDrag(event: DragEvent): void {
  if (!isLinkDrag(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'link'
}

/**
 * Takes a link dragged in from a browser and dropped outside the editor and the text fields, and
 * opens it in the OS. Left alone, WebKit loads the dragged URL in the window. The shell refuses
 * that load, but on WebKitGTK only after the app's `beforeunload` ran and its in-flight requests
 * were cancelled (`shell::navigation_guard`). WebKit fires `drop` only when `dragover` was
 * cancelled, so both are. A file drop (which carries `Files` as well) belongs to the file-drop
 * zones. Returns the cleanup.
 */
export function watchLinkDrops(
  host: DropHost,
  open: (url: string) => Promise<unknown>
): () => void {
  const onDrop = (event: DragEvent): void => {
    if (!isLinkDrag(event)) return
    event.preventDefault()
    const first = (event.dataTransfer?.getData('text/uri-list') ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('#'))
    const url = first ? parseUrl(first) : null
    if (!url || !['http:', 'https:', 'mailto:'].includes(url.protocol)) return
    open(url.href).catch((error: unknown) => log.warn('a dropped link did not open', error))
  }
  host.addEventListener('dragover', acceptLinkDrag)
  host.addEventListener('drop', onDrop)
  return () => {
    host.removeEventListener('dragover', acceptLinkDrag)
    host.removeEventListener('drop', onDrop)
  }
}

const openInOs = (url: string): Promise<unknown> => commands.shellOpenExternal(url)

export function installExternalLinkGuard(): () => void {
  const stopLinks = watchExternalLinks(document, openInOs, window.location.origin)
  const stopDrops = watchLinkDrops(document, openInOs)
  return () => {
    stopLinks()
    stopDrops()
  }
}
