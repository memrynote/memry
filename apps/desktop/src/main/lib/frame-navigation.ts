import { isAllowedExternalUrl } from './external-url'

export type FrameNavigationDecision = 'allow' | 'deny' | 'open-external'

export interface FrameNavigationContext {
  /** Whether the navigation targets the window's top-level frame. */
  isMainFrame: boolean
  /** The webContents' current URL (may be empty before the first load). */
  currentUrl: string
  /** Whether the app runs against the dev server (electron-vite HMR). */
  isDev: boolean
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTNAMES.has(url.hostname)
}

/** Same document = identical URL once the fragment is stripped (hash routing). */
function isSameDocument(a: URL, b: URL): boolean {
  const left = new URL(a.href)
  const right = new URL(b.href)
  left.hash = ''
  right.hash = ''
  return left.href === right.href
}

/**
 * Pure policy for `will-frame-navigate`: keeps every window's main frame pinned
 * to the local app origin (file:// document in prod, the dev server origin in
 * dev, plus the memry-file scheme) and re-routes external web/mail links to the
 * OS browser. Subframes stay permissive for http(s) — the CSP `frame-src`
 * directive is the origin gate for embeds (youtube-nocookie) — while local and
 * script schemes remain blocked. Loopback http targets that are not the dev
 * server are denied outright so renderer content can never point local services
 * at the user's default browser.
 */
export function decideFrameNavigation(
  rawUrl: string,
  { isMainFrame, currentUrl, isDev }: FrameNavigationContext
): FrameNavigationDecision {
  const target = parseUrl(rawUrl)
  if (!target) return 'deny'

  // App-controlled local scheme; the memry-file protocol handler enforces its
  // own directory allowlist (userData + vault) on every request.
  if (target.protocol === 'memry-file:') return 'allow'

  if (!isMainFrame) {
    // Frames initialize as about:blank / about:srcdoc before real content.
    if (target.protocol === 'about:') return 'allow'
    // http(s) embeds (youtube-nocookie today): CSP frame-src decides origins.
    if (target.protocol === 'https:' || target.protocol === 'http:') return 'allow'
    return 'deny'
  }

  const current = parseUrl(currentUrl)

  // Hash-only changes are in-app routing. Electron does not emit
  // will-frame-navigate for pure in-page navigation, but keep the policy total.
  if (current && isSameDocument(target, current)) return 'allow'

  if (target.protocol === 'file:') {
    // Prod app document: only a reload of the same file stays in-window.
    return current?.protocol === 'file:' && target.pathname === current.pathname ? 'allow' : 'deny'
  }

  if (target.protocol === 'https:' || target.protocol === 'http:') {
    // Dev server origin (HMR full reloads, vite page loads) stays in-window.
    if (isDev && current && target.origin === current.origin) return 'allow'
    // Never hand other loopback URLs to the OS browser.
    if (isLoopback(target)) return 'deny'
    return isAllowedExternalUrl(rawUrl) ? 'open-external' : 'deny'
  }

  if (target.protocol === 'mailto:') {
    return isAllowedExternalUrl(rawUrl) ? 'open-external' : 'deny'
  }

  // javascript:, data:, blob:, about:, memry: (OS deep link), anything else.
  return 'deny'
}
