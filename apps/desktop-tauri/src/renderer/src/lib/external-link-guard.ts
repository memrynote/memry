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
 * but on WebKitGTK only after the page's `beforeunload` ran, and a `mailto:` link starts no load
 * there for the shell to see. It runs after the handlers of the editor and the components, which
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

export function installExternalLinkGuard(): () => void {
  return watchExternalLinks(
    document,
    (url) => commands.shellOpenExternal(url),
    window.location.origin
  )
}
