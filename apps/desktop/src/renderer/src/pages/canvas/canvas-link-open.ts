/**
 * Decides what a click on an Excalidraw element's link should do.
 *
 * Excalidraw's own handler (App.tsx, `handleLinkClick`) ends in
 * `window.open(undefined, target)` followed by `newWindow.location = url`.
 * Under Electron that URL never reaches `setWindowOpenHandler` — the handler
 * sees `about:blank`, denies it, and `newWindow` is null, so a plain http link
 * silently does nothing. Its element links (`<location.href>?element=<id>`)
 * fare worse: when `isLocalLink` matches they assign `window.location`, which
 * reloads the whole SPA document.
 *
 * So the renderer owns the click instead: `onLinkOpen` calls this, then
 * `preventDefault()`s Excalidraw's event so none of the above runs.
 *
 * Pure — the current document's URL is a parameter, not a `window` read.
 */

import { parseMemryHref } from '@/lib/memry-links'

/** Excalidraw's element-link query key (`ELEMENT_LINK_KEY`). */
const ELEMENT_LINK_KEY = 'element'

export type CanvasLinkAction =
  /** A vault item: open it in a tab. */
  | { kind: 'memry'; href: string }
  /** Another element in this scene: move the viewport to it. */
  | { kind: 'element'; elementId: string }
  /** Anything else: hand it to the OS browser via the main-process allowlist. */
  | { kind: 'external'; url: string }
  /** Nothing we can act on — do nothing rather than guess. */
  | { kind: 'ignore' }

function sameDocument(a: URL, b: URL): boolean {
  // `origin` is the string "null" for every file: URL, so it cannot tell two
  // different local documents apart — compare the parts that can.
  return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname
}

/**
 * @param link  the element's `link`, already run through Excalidraw's
 *              `normalizeLink` (so `javascript:` is `about:blank` by here)
 * @param documentHref  `window.location.href` of the renderer document
 */
export function resolveCanvasLink(
  link: string | null | undefined,
  documentHref: string
): CanvasLinkAction {
  const trimmed = link?.trim()
  if (!trimmed) return { kind: 'ignore' }

  if (parseMemryHref(trimmed)) {
    return { kind: 'memry', href: trimmed }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    // Not an absolute URL. Excalidraw stores whatever the user typed, so this
    // is usually a half-written address — opening a guess is worse than not.
    return { kind: 'ignore' }
  }

  const elementId = url.searchParams.get(ELEMENT_LINK_KEY)
  if (elementId) {
    let current: URL | null = null
    try {
      current = new URL(documentHref)
    } catch {
      current = null
    }
    // Same document = an element link this session produced. A `file:` URL with
    // the same query is one produced on ANOTHER device: the scene syncs but the
    // absolute path in it does not, so match on the marker rather than the path
    // and the link keeps working everywhere. (Excalidraw builds these from
    // `window.location.href`; we do not control the format — see the plan's Q9.)
    if ((current && sameDocument(url, current)) || url.protocol === 'file:') {
      return { kind: 'element', elementId }
    }
  }

  return { kind: 'external', url: trimmed }
}
