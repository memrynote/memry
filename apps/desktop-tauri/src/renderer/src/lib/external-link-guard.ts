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
 * Sends a clicked web or mail link to the OS and keeps the page where it is. WKWebView and
 * WebKitGTK report a frame's own navigation and the main frame's alike, so the shell lets every
 * web navigation through for the frames of a note's HTML embed (`frame_nav`). This listener is
 * what keeps a link the app itself rendered from replacing the app. It runs after the handlers
 * of the editor and the components, which claim their own links with `preventDefault`.
 * Returns the cleanup.
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
  addEventListener(type: 'drop', listener: (event: DragEvent) => void, capture: boolean): void
  removeEventListener(type: 'drop', listener: (event: DragEvent) => void, capture: boolean): void
}

const EDITABLE = 'input, textarea, [contenteditable], .ProseMirror'

function cancelLinkDrop(event: DragEvent): void {
  const types = event.dataTransfer?.types ?? []
  if (!types.includes('text/uri-list') || types.includes('Files')) return
  if (event.target instanceof Element && event.target.closest(EDITABLE)) return
  event.preventDefault()
}

/**
 * Stops a link dragged in from a browser from navigating the window. A drop nothing handles makes
 * WebKit load the dragged URL, and the main window's drag-drop handler is off, so nothing else
 * sees it. The editor and the text fields take a dropped link as text, and a file drop (which
 * carries `Files` as well) belongs to the file-drop zones. Returns the cleanup.
 */
export function watchLinkDrops(host: DropHost): () => void {
  host.addEventListener('drop', cancelLinkDrop, true)
  return () => host.removeEventListener('drop', cancelLinkDrop, true)
}

export function installExternalLinkGuard(): () => void {
  const stopLinks = watchExternalLinks(
    document,
    (url) => commands.shellOpenExternal(url),
    window.location.origin
  )
  const stopDrops = watchLinkDrops(document)
  return () => {
    stopLinks()
    stopDrops()
  }
}
