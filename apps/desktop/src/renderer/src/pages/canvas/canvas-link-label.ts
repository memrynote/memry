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

/** Longest label the bubble shows before it starts eliding. */
export const MAX_LABEL_LENGTH = 48

export function truncateLabel(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_LABEL_LENGTH
    ? `${collapsed.slice(0, MAX_LABEL_LENGTH - 1)}…`
    : collapsed
}

/** The subset of a scene element this file reads. */
export interface LabelElement {
  id: string
  type: string
  text?: string
  containerId?: string | null
  isDeleted?: boolean
  customData?: Record<string, unknown> | null
}

/**
 * What an element link points at, as far as naming it goes.
 *
 * Excalidraw elements have no name, so unlike a `memry://` link there is nothing
 * to bake into the href — and nothing needs to be: the target is in the same
 * scene, so it is read live and a renamed or re-typed target is never stale.
 */
export type ElementLinkTarget =
  /** A Memry card: name it by the item it shows. */
  | { kind: 'entity'; entityType: string; entityId: string }
  /** A text element, or a shape with text bound into it. */
  | { kind: 'text'; text: string }
  /** Present, but carries nothing to name it by. */
  | { kind: 'shape' }
  /** Deleted, or from a scene this element link no longer matches. */
  | { kind: 'missing' }

export function elementLinkTarget(
  elementId: string,
  elements: readonly LabelElement[]
): ElementLinkTarget {
  const target = elements.find((element) => element.id === elementId && !element.isDeleted)
  if (!target) return { kind: 'missing' }

  const entityType = target.customData?.['entityType']
  const entityId = target.customData?.['entityId']
  if (typeof entityType === 'string' && typeof entityId === 'string') {
    return { kind: 'entity', entityType, entityId }
  }

  // A text element carries its own text; a rectangle carries it in a separate
  // text element bound back to the container.
  const own = target.text?.trim()
  if (own) return { kind: 'text', text: own }

  const bound = elements
    .find((element) => element.containerId === elementId && !element.isDeleted)
    ?.text?.trim()
  if (bound) return { kind: 'text', text: bound }

  return { kind: 'shape' }
}
