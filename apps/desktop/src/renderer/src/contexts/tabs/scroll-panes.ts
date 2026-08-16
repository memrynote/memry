/**
 * Per-pane scroll records
 *
 * A tab used to keep ONE scroll record stamped with the pane it came from, so
 * the second pane the user scrolled overwrote the first: Overview → Notes →
 * Overview lost the Overview offset every round trip. A tab now keeps one entry
 * PER PANE, and a pane only ever reads and writes its own.
 */

import type { Tab, TabScrollEntry, TabScrollPanes } from './types'

/**
 * Slot for a page that owns a single scroller and passes no key. Empty rather
 * than a sentinel word so it can never collide with a real pane key.
 */
export const DEFAULT_SCROLL_PANE_KEY = ''

/**
 * Upper bound on entries per tab. The session is serialised to local storage,
 * which has a size ceiling the user is toasted about when it is hit, so the map
 * cannot be allowed to grow with every pane a tab has ever shown. The busiest
 * real page is the project hub at six scrollers (overview, notes, files,
 * events, rail, tasks), so this leaves headroom without being unbounded.
 */
export const MAX_SCROLL_PANES = 8

/** Normalise the caller's optional key into a map key. */
export const scrollPaneKey = (key?: string): string => key ?? DEFAULT_SCROLL_PANE_KEY

/**
 * The entry a pane should restore from, or `undefined` when it has none.
 *
 * Sessions written before the map existed carry a single `scrollState` record
 * stamped with its own `key` (PR #1549, shipped). That record is the entry for
 * the pane it names — an unkeyed record belongs to the unkeyed pane — so it is
 * migrated forward here rather than discarded. It is left in place on the tab
 * instead of being rewritten: the map shadows it for every pane that has an
 * entry, and leaving it means a user who rolls back to that build still finds
 * their offset where it expects one.
 */
export function readScrollPane(
  tab: Pick<Tab, 'scrollPanes' | 'scrollState'> | undefined,
  key?: string
): TabScrollEntry | undefined {
  if (!tab) return undefined
  const entry = tab.scrollPanes?.[scrollPaneKey(key)]
  if (entry !== undefined) return entry

  const legacy = tab.scrollState
  if (legacy === undefined || scrollPaneKey(legacy.key) !== scrollPaneKey(key)) return undefined
  return { offset: legacy.offset, entityId: legacy.entityId }
}

/**
 * Merge a pane patch over the tab's existing entries, bounded.
 *
 * Insertion order is the recency order eviction reads, so a written pane is
 * re-inserted at the end and the least recently written entries fall off the
 * front once the map is over `MAX_SCROLL_PANES`.
 */
export function mergeScrollPanes(
  current: TabScrollPanes | undefined,
  patch: TabScrollPanes
): TabScrollPanes {
  const next: TabScrollPanes = { ...current }
  for (const [key, entry] of Object.entries(patch)) {
    delete next[key]
    next[key] = entry
  }

  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SCROLL_PANES))) {
    delete next[key]
  }
  return next
}
