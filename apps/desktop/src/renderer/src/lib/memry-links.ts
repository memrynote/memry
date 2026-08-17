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
 */

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
 * `label` is the item's title as it read when the link was written. It exists so
 * a surface that can only render the link string — Excalidraw's link bubble
 * shows `element.link` verbatim, with no hook to change it — can still show a
 * name instead of an id, without a lookup and without being online. It is a
 * cached display hint, never an identity: the id is what resolves.
 */
export type ParsedMemryHref = { label: string | null } & (
  | { kind: Exclude<MemryLinkKind, 'calendar_event'>; id: string }
  | { kind: 'calendar_event'; id: string; date: string | null }
)

/** Hostnames whose whole path is the item id. */
const SIMPLE_HOSTS = ['note', 'file', 'task', 'inbox', 'journal', 'project', 'folder'] as const

type SimpleHost = (typeof SIMPLE_HOSTS)[number]

function isSimpleHost(value: string): value is SimpleHost {
  return (SIMPLE_HOSTS as readonly string[]).includes(value)
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

  if (isSimpleHost(url.hostname)) {
    return { kind: url.hostname, id, label }
  }

  if (url.hostname === 'calendar') {
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
}

/**
 * The inverse of `parseMemryHref`. Returns null when the input cannot produce a
 * link that resolves — a calendar event with no date has no day to focus, so a
 * link to it would parse and then refuse to open.
 */
export function buildMemryHref({ kind, id, date, label }: MemryHrefInput): string | null {
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
  return query ? `${path}?${query}` : path
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
