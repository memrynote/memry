import { commands } from '../../../generated/bindings'
import { createLogger } from './logger'

const log = createLogger('ExternalLinks')

/**
 * Why the window never navigates itself: the shell refuses a main-frame navigation off the app
 * (`shell::navigation_guard`), but on WebKitGTK only after the page's `beforeunload` ran and its
 * in-flight requests were cancelled; Tauri resends an aborted `ipc://` command, so it can run
 * twice. So no event of the app may keep a default action that navigates the top frame:
 * activating a link (`click`, `auxclick`, Enter, with any button or modifier), dropping anything
 * outside a text field (`dragenter`, `dragover`, `drop`: a link, a file, an image, text) and
 * submitting a form. App code never assigns `location` (the `memry/no-location-navigation` lint).
 *
 * The listeners sit on `window` in the capture phase, installed before the app renders, so they
 * run before every handler of the app: one that stops propagation cannot hide an event from them.
 * They cancel the default action at once and, after the dispatch, follow the link unless a later
 * handler claimed the event with `preventDefault` (the editor, a drop zone). Those handlers see
 * `defaultPrevented` exactly as they would without this guard. An activated link goes to the shell
 * (`shell_open_link`), which sends it where the main frame's navigation would have: a web or mail
 * link to the OS browser, a vault file to its app (a file block's Download, as in Electron);
 * a dropped one only when it is a web or mail link.
 *
 * Left alone, because their default stays in the document: a link to a fragment of this document,
 * a `download` link to this origin, `blob:` or `data:` (the engines ignore `download` on any other
 * and navigate), and a drag over an editable element without files (the editor and text fields
 * insert it; a file the editor does not claim would make WebKit load it instead).
 */

type GuardedEvent = 'click' | 'auxclick' | 'dragenter' | 'dragover' | 'drop' | 'submit'

interface CaptureHost<K extends GuardedEvent, E extends Event> {
  addEventListener(type: K, listener: (event: E) => void, capture: true): void
  removeEventListener(type: K, listener: (event: E) => void, capture: true): void
}

type Open = (url: string) => Promise<unknown>

/** `URL.parse` is too new for the oldest WKWebView the app supports. */
function parseUrl(href: string, base?: string): URL | null {
  try {
    return new URL(href, base)
  } catch {
    return null
  }
}

const OPENED = new Set(['http:', 'https:', 'mailto:'])
const SVG = 'http://www.w3.org/2000/svg'
const XLINK = 'http://www.w3.org/1999/xlink'

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

interface Link {
  raw: string
  url: URL | null
  download: boolean
}

/** The `<a>`, `<area>` or SVG `<a>` with an address that the event's path goes through. */
function linkOf(event: Event): Link | null {
  for (const node of event.composedPath()) {
    if (!(node instanceof Element)) continue
    const html = node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement
    const svg = node.namespaceURI === SVG && node.localName === 'a'
    if (!html && !svg) continue
    const raw = node.getAttribute('href') ?? (svg ? node.getAttributeNS(XLINK, 'href') : null)
    if (raw === null) continue
    return { raw, url: parseUrl(raw, node.baseURI), download: node.hasAttribute('download') }
  }
  return null
}

/** A link to a fragment of the current document only scrolls; `href=""` would reload it. */
function staysInDocument(link: Link): boolean {
  const here = parseUrl(document.URL)
  const target = link.url ? parseUrl(link.url.href) : null
  if (!target || !here || !link.raw.includes('#')) return false
  target.hash = ''
  here.hash = ''
  return target.href === here.href
}

/**
 * A download the engine performs: `download` is honored only for these URLs. An opaque origin,
 * serialized `"null"` (a non-special scheme such as `memry-file:` or the page's own `tauri:`), is
 * never the same as another.
 */
function downloads(link: Link): boolean {
  if (!link.download || !link.url) return false
  if (link.url.protocol === 'blob:' || link.url.protocol === 'data:') return true
  const { origin } = link.url
  return origin !== 'null' && origin === parseUrl(document.URL)?.origin
}

function follow(open: Open, url: URL | null): void {
  if (!url) {
    log.warn('a link whose address does not parse was not followed')
    return
  }
  open(url.href).catch((error: unknown) => log.warn('a link was not opened', error))
}

/**
 * Keeps every link activation from navigating the window, and follows a link a primary or middle
 * click activated. Returns the cleanup.
 */
export function watchExternalLinks(
  host: CaptureHost<'click' | 'auxclick', MouseEvent>,
  open: Open
): () => void {
  // `isTrusted` is not checked: a script's `link.click()` navigates the frame like a person's
  // click, so it is cancelled and followed the same way. Only the app's own code runs in this
  // document (an embed is its own frame with its own window), and the shell decides what opens.
  const onActivate = (event: MouseEvent): void => {
    if (event.defaultPrevented) return
    const link = linkOf(event)
    if (!link || downloads(link) || staysInDocument(link)) return
    // A middle click fires `auxclick`; a right click opens the context menu and nothing else.
    const opens = event.type === 'click' ? event.button === 0 : event.button === 1
    preventUnlessClaimed(event, () => {
      if (opens) follow(open, link.url)
    })
  }
  host.addEventListener('click', onActivate, true)
  host.addEventListener('auxclick', onActivate, true)
  return () => {
    host.removeEventListener('click', onActivate, true)
    host.removeEventListener('auxclick', onActivate, true)
  }
}

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number'])

/** The editor and text fields insert what is dropped on them; that default stays in the page. */
function isEditable(target: EventTarget | undefined): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('textarea')) return true
  const input = target.closest('input')
  if (input) return TEXT_INPUTS.has(input.type)
  const owner = target.closest('[contenteditable]')
  return owner !== null && owner.getAttribute('contenteditable') !== 'false'
}

type Drag = Event & { dataTransfer?: DataTransfer | null }

/** The web address dragged in from a browser; a file drag carries `Files` as well. */
function droppedLink(event: Drag): URL | null {
  const data = event.dataTransfer
  if (!data || !data.types.includes('text/uri-list') || data.types.includes('Files')) return null
  const first = data
    .getData('text/uri-list')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'))
  return first ? parseUrl(first) : null
}

/**
 * Keeps every drag outside a text field from loading what it carries in the window, and opens a
 * web or mail link dropped there in the OS. A zone that claims the drag (`preventDefault`) keeps
 * it. WebKit fires `drop` only when the last `dragenter` or `dragover` was cancelled (entering a
 * new element it takes the answer from `dragenter`); otherwise it loads the dragged URL. Returns
 * the cleanup.
 */
export function watchDrops(
  host: CaptureHost<'dragenter' | 'dragover' | 'drop', Drag>,
  open: Open
): () => void {
  const onDrag = (event: Drag): void => {
    if (event.defaultPrevented) return
    const files = event.dataTransfer?.types.includes('Files') === true
    if (!files && isEditable(event.composedPath()[0])) return
    const link = event.type === 'drop' ? droppedLink(event) : null
    preventUnlessClaimed(event, () => {
      if (link && OPENED.has(link.protocol)) follow(open, link)
    })
  }
  for (const type of ['dragenter', 'dragover', 'drop'] as const) {
    host.addEventListener(type, onDrag, true)
  }
  return () => {
    for (const type of ['dragenter', 'dragover', 'drop'] as const) {
      host.removeEventListener(type, onDrag, true)
    }
  }
}

function onSubmit(event: Event): void {
  if (event.defaultPrevented) return
  preventUnlessClaimed(event, () => log.warn('a form the app does not handle was not submitted'))
}

/** A form the app does not handle would load its action, by default this page. */
export function watchFormSubmits(host: CaptureHost<'submit', Event>): () => void {
  host.addEventListener('submit', onSubmit, true)
  return () => host.removeEventListener('submit', onSubmit, true)
}

const followInShell = (url: string): Promise<unknown> => commands.shellOpenLink(url)

/** Installed before the app renders (`main.tsx`), so its listeners run first. */
export function installExternalLinkGuard(): () => void {
  const stops = [
    watchExternalLinks(window, followInShell),
    watchDrops(window, followInShell),
    watchFormSubmits(window)
  ]
  return () => {
    for (const stop of stops) stop()
  }
}
