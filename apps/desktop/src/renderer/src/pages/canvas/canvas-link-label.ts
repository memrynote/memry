/**
 * What Excalidraw's link bubble should say for a `memry://` link.
 *
 * The bubble renders `element.link` verbatim — `<a>{element.link}</a>` with no
 * prop to change it — so a link to a note reads as `memry://note/s5b2qadr6tg4`.
 * The href carries the item's title as a `label` hint (see `buildMemryHref`),
 * which is enough to show a name instead, wiki-link style, with no lookup.
 *
 * Pure and DOM-free: the caller does the swapping, this decides the text.
 */

import { parseMemryHref } from '@/lib/memry-links'

/** The class Excalidraw puts on the anchor inside its link bubble. */
export const HYPERLINK_ANCHOR_SELECTOR = 'a.excalidraw-hyperlinkContainer-link'

/**
 * The text to display, or null to leave whatever is there alone.
 *
 * Null covers every case where we would be guessing: a non-memry link (the URL
 * is the honest label), a link written before labels existed, and one written
 * by a backend that did not include a title. Showing `note s5b2qadr6tg4` in
 * those cases would be less useful than the URL, not more.
 */
export function linkBubbleLabel(href: string | null | undefined): string | null {
  if (!href) return null
  const parsed = parseMemryHref(href)
  if (!parsed) return null

  // A journal's id IS its date — already the name a user would recognise.
  if (parsed.kind === 'journal') return parsed.label ?? parsed.id

  // A folder's id is its path; the leaf is what the sidebar shows.
  if (parsed.kind === 'folder') {
    return parsed.label ?? parsed.id.split('/').filter(Boolean).pop() ?? parsed.id
  }

  return parsed.label
}
