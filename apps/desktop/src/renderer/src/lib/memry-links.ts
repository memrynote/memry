/**
 * The `memry://` deep-link grammar — one parser, one tab builder, shared by
 * every surface that can hand the user a link to a vault item.
 *
 * Two copies of this grammar used to exist: agent-chat's message links (all
 * item kinds) and the spatial canvas' card redirect (notes, tasks and events
 * only). A field added to one was silently missing from the other, so they are
 * merged here and both surfaces import from this module.
 *
 * Pure on purpose: `now` is a parameter rather than a `Date.now()` call so the
 * builder unit-tests without faking the clock, and so a caller that re-fires a
 * focus can control the token it stamps.
 *
 * A link can also address a place INSIDE a note, in the URL fragment. The
 * fragment is deliberate: the parser resolves an item from the path and the
 * query alone, so a build that has never heard of anchors — every build shipped
 * before this one — reads the same note out of an anchored link and ignores the
 * rest. That is the whole of the cross-version story, and it is why an anchor
 * must never move into the query.
 */

import { isBlockReference, splitWikiTarget } from '@memry/shared/wiki-target'
import type { Tab } from '@/contexts/tabs/types'

/** A tab descriptor as `openTab` accepts it — ids and timestamps are its job. */
export type OpenableTab = Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>

/**
 * `file` is the filed-binary kind: a PDF/image/audio/video living in the vault.
 * Search returns those as `note` rows (see `NoteResultMetadata.fileType`), but
 * they must open in the file viewer, never the markdown editor (#800).
 */
export type MemryLinkKind =
  'note' | 'file' | 'task' | 'inbox' | 'journal' | 'project' | 'folder' | 'calendar_event'

/**
 * Where inside a note a link lands, in the two forms the two consumers need.
 *
 * A `block` anchor names a block by its id. Block ids are minted when a document
 * is parsed and markdown does not carry them, so they live exactly as long as
 * the collaborative document that minted them — a fresh device, a copied vault
 * or a rebuild mints new ones. A block anchor is therefore only ever right for a
 * click handed straight back into the same session.
 *
 * A `heading` anchor names a heading by its TEXT, which is all a link can carry
 * that outlives the document: it is what survives being written into a canvas
 * file, synced, and opened on another device months later. It is also already
 * the house convention — `[[Note#Heading]]` names a heading by text, and the
 * note page matches it with `normalizeHeading`, trimmed and case-folded, first
 * match wins. Nothing here matches; this is the reading of the link.
 */
export type MemryAnchor = { type: 'block'; id: string } | { type: 'heading'; text: string }

/**
 * `label` is the item's title as it read when the link was written. It exists so
 * a surface that can only render the link string — Excalidraw's link bubble
 * shows `element.link` verbatim, with no hook to change it — can still show a
 * name instead of an id, without a lookup and without being online. It is a
 * cached display hint, never an identity: the id is what resolves.
 *
 * `anchor` is present only when the link carries one this build can use, and
 * only on `note`: a note is the only kind with an inside to address. It is
 * absent — not null — when there is none, so an unanchored link parses to the
 * object it has always parsed to.
 */
export type ParsedMemryHref = { label: string | null } & (
  | { kind: 'note'; id: string; anchor?: MemryAnchor }
  | { kind: Exclude<MemryLinkKind, 'calendar_event' | 'note'>; id: string }
  | { kind: 'calendar_event'; id: string; date: string | null }
)

/** Hostnames whose whole path is the item id. */
const SIMPLE_HOSTS = ['note', 'file', 'task', 'inbox', 'journal', 'project', 'folder'] as const

type SimpleHost = (typeof SIMPLE_HOSTS)[number]

function isSimpleHost(value: string): value is SimpleHost {
  return (SIMPLE_HOSTS as readonly string[]).includes(value)
}

/** Percent-decodes one half of an anchor, or null when it says nothing. */
function decodeAnchorPart(value: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    // A malformed percent escape. The note came out of the path and is already
    // resolved, so the anchor is what gets dropped, never the link.
    return null
  }
  return decoded.trim() || null
}

/**
 * The fragment, read as the heading half of a wiki-link target.
 *
 * `memry://note/n1#Heading` is `[[Note#Heading]]` and `memry://note/n1#^b3` is
 * `[[Note#^b3]]`, on purpose: one convention for "an item, then a place inside
 * it" rather than a second one that reads differently. `splitWikiTarget` is
 * what splits it, so `#A#B` names `B` here exactly as it does there, and
 * `isBlockReference` is what tells the two forms apart.
 *
 * The `^` marker is tested BEFORE decoding, which is what keeps a heading whose
 * text really begins with a caret — written `%5E…` — from being read as a block.
 *
 * Null for every anchor this build cannot turn into a place: no fragment, a
 * block marker with no id, a fragment that will not decode. An anchor FORM a
 * later build invents is not null but is equally harmless — it reads as heading
 * text that matches no heading, and the reader lands at the top of the note,
 * which is where a build with no anchors at all would have put them.
 */
function parseAnchor(hash: string): MemryAnchor | null {
  // `url.hash` keeps its leading `#`, which is the separator `splitWikiTarget`
  // looks for — an empty fragment is the empty string and splits to no heading.
  const { heading } = splitWikiTarget(hash)
  if (!heading) return null

  if (isBlockReference(heading)) {
    const id = decodeAnchorPart(heading.slice(1))
    return id ? { type: 'block', id } : null
  }

  const text = decodeAnchorPart(heading)
  return text ? { type: 'heading', text } : null
}

export function parseMemryHref(href: string): ParsedMemryHref | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }

  if (url.protocol !== 'memry:') return null

  const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  if (!id) return null

  const label = url.searchParams.get('label')
  const host = url.hostname

  if (isSimpleHost(host)) {
    if (host === 'note') {
      const anchor = parseAnchor(url.hash)
      return anchor ? { kind: 'note', id, label, anchor } : { kind: 'note', id, label }
    }
    // Every other kind is a whole item, with no inside to point at, so an
    // anchor on one is dropped and the item still opens.
    return { kind: host, id, label }
  }

  if (host === 'calendar') {
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'event' || !parts[1]) return null
    return {
      kind: 'calendar_event',
      id: decodeURIComponent(parts[1]),
      date: url.searchParams.get('date'),
      label
    }
  }

  return null
}

export interface MemryHrefInput {
  kind: MemryLinkKind
  id: string
  /** `YYYY-MM-DD` — required for `calendar_event`, ignored otherwise. */
  date?: string | null
  /** The item's title, carried along as a display hint. See `ParsedMemryHref`. */
  label?: string | null
  /**
   * Where inside the note to land. Ignored by every other kind, which has no
   * inside — a link to a task opens the task, anchor or no anchor.
   *
   * A link that will be written to disk must use a `heading` anchor: block ids
   * die with the document that minted them. See `MemryAnchor`.
   */
  anchor?: MemryAnchor | null
}

/** The fragment for an anchor, `#` included, or '' when there is nothing to say. */
function buildAnchorFragment(anchor: MemryAnchor | null | undefined): string {
  if (!anchor) return ''
  if (anchor.type === 'block') {
    const id = anchor.id.trim()
    // The `^` stays literal — it is the marker the parser reads before it
    // decodes, and encoding it would make the anchor a heading called `^id`.
    return id ? `#^${encodeURIComponent(id)}` : ''
  }
  const text = anchor.text.trim()
  return text ? `#${encodeURIComponent(text)}` : ''
}

/**
 * The inverse of `parseMemryHref`. Returns null when the input cannot produce a
 * link that resolves — a calendar event with no date has no day to focus, so a
 * link to it would parse and then refuse to open.
 *
 * An anchor that says nothing is left off rather than refused: the note is what
 * the link is for, and it opens either way.
 */
export function buildMemryHref({ kind, id, date, label, anchor }: MemryHrefInput): string | null {
  if (!id) return null

  const params = new URLSearchParams()
  if (kind === 'calendar_event') {
    if (!date) return null
    params.set('date', date)
  }
  if (label) params.set('label', label)

  const path =
    kind === 'calendar_event'
      ? `memry://calendar/event/${encodeURIComponent(id)}`
      : `memry://${kind}/${encodeURIComponent(id)}`
  const query = params.toString()
  const fragment = kind === 'note' ? buildAnchorFragment(anchor) : ''
  return `${path}${query ? `?${query}` : ''}${fragment}`
}

export interface TabFromHrefOptions {
  /** Label for kinds that carry their own title (note, file, project, folder). */
  title?: string
  /**
   * Monotonic token so re-opening the same item re-fires the page's focus
   * effect. Defaults to 0, which is stable — pass `Date.now()` from a click.
   */
  now?: number
}

const BASE = {
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false
} as const

/**
 * Builds the tab that opens a `memry://` href "as if the item were clicked in
 * its home view". Returns null for anything this grammar cannot resolve.
 *
 * An anchor the href carries is deliberately not read here. A tab says WHICH
 * item to open; where inside it to land is the page's own business, and the
 * caller that wants it reads `parseMemryHref(...).anchor`.
 */
export function tabFromMemryHref(
  href: string,
  options: TabFromHrefOptions = {}
): OpenableTab | null {
  const parsed = parseMemryHref(href)
  if (!parsed) return null

  const { title, now = 0 } = options

  switch (parsed.kind) {
    case 'note':
      return {
        ...BASE,
        type: 'note',
        title: title ?? parsed.label ?? 'Note',
        icon: 'file-text',
        path: `/note/${parsed.id}`,
        entityId: parsed.id
      }
    case 'file':
      return {
        ...BASE,
        type: 'file',
        title: title ?? parsed.label ?? 'File',
        icon: 'file-text',
        path: `/file/${parsed.id}`,
        entityId: parsed.id
      }
    case 'task':
      return {
        ...BASE,
        type: 'tasks',
        title: 'Tasks',
        icon: 'check-square',
        path: '/tasks',
        viewState: { openTaskId: parsed.id }
      }
    case 'inbox':
      return {
        ...BASE,
        type: 'inbox',
        title: 'Inbox',
        icon: 'inbox',
        path: '/inbox',
        viewState: { focusInboxItemId: parsed.id, focusedAt: now }
      }
    case 'journal':
      return {
        ...BASE,
        type: 'journal',
        title: `Journal - ${parsed.id}`,
        icon: 'book-open',
        path: `/journal/${parsed.id}`,
        entityId: parsed.id,
        viewState: { date: parsed.id }
      }
    case 'project':
      return {
        ...BASE,
        type: 'project',
        title: title ?? parsed.label ?? 'Project',
        icon: 'folder',
        path: `/project/${parsed.id}`,
        entityId: parsed.id
      }
    case 'folder':
      return {
        ...BASE,
        type: 'folder',
        title: title ?? parsed.label ?? parsed.id,
        icon: 'folder',
        path: `/folder/${encodeURIComponent(parsed.id)}`,
        entityId: parsed.id
      }
    case 'calendar_event': {
      // No date means no day to focus: `focusDate` drives which day the
      // calendar scrolls to, and a null one lands the user on today with a
      // focus id nothing on screen matches.
      if (!parsed.date) return null
      return {
        ...BASE,
        type: 'calendar',
        title: 'Calendar',
        icon: 'calendar',
        path: '/calendar',
        viewState: {
          focusCalendarEventId: parsed.id,
          focusDate: parsed.date,
          focusedAt: now
        }
      }
    }
  }
}
