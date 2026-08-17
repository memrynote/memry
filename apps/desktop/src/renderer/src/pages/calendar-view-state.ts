/**
 * What a Calendar tab remembers, and how it is read back.
 *
 * Everything here used to be either global (the view, in one localStorage key
 * shared by every calendar anywhere) or thrown away on unmount (the filters),
 * or shared through an app-level context that resets to today on restart (the
 * anchor date).
 *
 * Two things are deliberately NOT owned here:
 *
 * - The anchor date is still LIVE in `CalendarViewContext`, because the day
 *   panel — which is not in a tab at all — sets it. The tab is the durable
 *   record of that shared value, not a second copy of it. See
 *   `resolveAnchorSync` for the handshake that keeps the two from overwriting
 *   each other.
 * - The selected imported calendars are stored as the user's EXPLICIT choice
 *   or as `null` for "has not chosen". "All of them" is derived from the
 *   sources query at read time (`resolveSelectedSourceIds`) rather than
 *   materialised into tab state, so the page never has to race its own seeding
 *   effect, and a source that appears later is not silently pre-selected into
 *   a choice the user did make.
 */

import type { CalendarWorkspaceView } from '@/components/calendar'
import { VISUAL_TYPE_ORDER } from '@/components/calendar/visual-type-meta'
import type { CalendarProjectionVisualType } from '@/services/calendar-service'

/** Pre-existing GLOBAL key. Still read, and still written, so a rollback works. */
export const CALENDAR_VIEW_STORAGE_KEY = 'calendar-view'

export const CALENDAR_VIEW_STATE_KEYS = {
  /** Day / week / month / year. */
  view: 'calendarView',
  /** The date the view is centred on, as `YYYY-MM-DD`. */
  anchorDate: 'calendarAnchorDate',
  /** Whether items memrynote owns are shown. */
  showMemryItems: 'calendarShowMemryItems',
  /** Whether imported calendars are shown at all. */
  showImportedCalendars: 'calendarShowImportedCalendars',
  /** The user's explicit source selection. `null` means "has not chosen". */
  importedSourceIds: 'calendarImportedSourceIds',
  /** Which kinds of item are shown. */
  visualTypes: 'calendarVisualTypes'
} as const

/**
 * One key per scroller. Day, week and year are separate components with
 * different content heights, so an offset from one is meaningless in another.
 * Month has no scroller — the grid fits its pane.
 */
export const CALENDAR_SCROLL_KEYS = {
  day: 'calendar-day',
  week: 'calendar-week',
  year: 'calendar-year'
} as const

export const CALENDAR_VIEWS: CalendarWorkspaceView[] = ['day', 'week', 'month', 'year']

export const parseCalendarView = (raw: unknown): CalendarWorkspaceView | undefined =>
  typeof raw === 'string' && (CALENDAR_VIEWS as string[]).includes(raw)
    ? (raw as CalendarWorkspaceView)
    : undefined

/**
 * The view a NEW calendar tab opens on: whatever view was last used anywhere.
 *
 * The global key predates per-tab state, so an upgrading user must find their
 * calendar exactly where they left it. It stays the fallback rather than the
 * store: once a tab has its own view, that is what it opens on.
 */
export function readGlobalCalendarView(): CalendarWorkspaceView {
  try {
    return parseCalendarView(localStorage.getItem(CALENDAR_VIEW_STORAGE_KEY)) ?? 'month'
  } catch {
    /* localStorage unavailable */
    return 'month'
  }
}

export function writeGlobalCalendarView(view: CalendarWorkspaceView): void {
  try {
    localStorage.setItem(CALENDAR_VIEW_STORAGE_KEY, view)
  } catch {
    /* localStorage unavailable */
  }
}

/**
 * `YYYY-MM-DD` only. Everything downstream (`parseLocalDate`, the range query,
 * the week virtualizer's day index) assumes that shape, and a restored session
 * can carry anything.
 */
export const parseAnchorDate = (raw: unknown): string | null | undefined => {
  if (raw === null) return null
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined
  return raw
}

export const parseCalendarBoolean = (raw: unknown): boolean | undefined =>
  typeof raw === 'boolean' ? raw : undefined

/**
 * `null` is a value here — "the user has not chosen any subset" — and must be
 * told apart from "nothing stored", which also lands on `null` by default.
 * Unknown entries are kept: a source can be missing because its account is
 * still loading, and dropping it would quietly deselect it.
 */
export const parseImportedSourceIds = (raw: unknown): string[] | null | undefined => {
  if (raw === null) return null
  if (!Array.isArray(raw)) return undefined
  return raw.filter((value): value is string => typeof value === 'string')
}

/** Unknown visual types are dropped rather than rejecting the whole filter. */
export const parseVisualTypes = (raw: unknown): CalendarProjectionVisualType[] | undefined =>
  Array.isArray(raw)
    ? raw.filter(
        (value): value is CalendarProjectionVisualType =>
          typeof value === 'string' && (VISUAL_TYPE_ORDER as string[]).includes(value)
      )
    : undefined

/**
 * The sources actually shown: every available source until the user picks a
 * subset, then their pick, minus anything that has since disappeared.
 *
 * Derived rather than stored so there is no first-load seeding effect to fight,
 * and so a newly connected calendar cannot be quietly added to a selection the
 * user made by hand.
 */
export function resolveSelectedSourceIds(
  stored: string[] | null,
  availableIds: string[]
): string[] {
  if (stored === null) return availableIds
  return stored.filter((id) => availableIds.includes(id))
}

export interface AnchorSyncInput {
  /**
   * The value pushed into the shared context and not yet seen coming back, or
   * `null` when nothing is in flight.
   */
  awaitingSeed: string | null
  /** The shared context's current anchor. */
  anchorDate: string
  /** What the tab currently has stored, or `null` when it has nothing. */
  storedAnchor: string | null
}

export interface AnchorSyncDecision {
  /** The seed has landed; stop waiting for it. */
  clearAwaiting: boolean
  /** Value to write into tab state, or `null` to write nothing this pass. */
  write: string | null
}

/**
 * The one-way handshake between the shared anchor and the tab's copy of it.
 *
 * Restoring is a two-step: the tab's stored anchor is pushed into the context,
 * and only the NEXT render sees the context carrying it. In between, the
 * mirror still sees the context's "today" — and writing that would overwrite
 * the very anchor being restored with today's date, every single launch. So
 * while a seed is in flight nothing is written until the context agrees with
 * it.
 */
export function resolveAnchorSync({
  awaitingSeed,
  anchorDate,
  storedAnchor
}: AnchorSyncInput): AnchorSyncDecision {
  if (awaitingSeed !== null) {
    if (anchorDate !== awaitingSeed) return { clearAwaiting: false, write: null }
    return { clearAwaiting: true, write: anchorDate === storedAnchor ? null : anchorDate }
  }
  return { clearAwaiting: false, write: anchorDate === storedAnchor ? null : anchorDate }
}
