import type { Tab, TabContentSnapshot, TabGroup, TabHistoryEntry } from '../types'

export const HISTORY_LIMIT = 50

const cap = (entries: TabHistoryEntry[]): TabHistoryEntry[] =>
  entries.length > HISTORY_LIMIT ? entries.slice(-HISTORY_LIMIT) : entries

/** Freeze what a tab is showing, so history can put it back later. */
export const snapshotTabContent = (tab: Tab): TabContentSnapshot => ({
  type: tab.type,
  title: tab.title,
  icon: tab.icon,
  emoji: tab.emoji,
  path: tab.path,
  entityId: tab.entityId,
  scrollPosition: tab.scrollPosition,
  scrollState: tab.scrollState,
  scrollPanes: tab.scrollPanes,
  viewState: tab.viewState
})

/**
 * Do two pieces of tab content address the same thing?
 *
 * Entity tabs compare by `entityId` ALONE, deliberately. A note that turns out
 * to be a binary is converted in place — same entity, new `type` and `path`
 * (see `pages/note.tsx`) — and that conversion is a correction, not a
 * navigation. Treating it as one would push a back entry that returns to the
 * note view, which re-probes and converts again: a back button that loops.
 *
 * Non-entity tabs (home, inbox, a search) have no id to compare, so they fall
 * back to type + path.
 */
export const isSameDestination = (
  a: Pick<Tab, 'type' | 'path' | 'entityId'>,
  b: Pick<Tab, 'type' | 'path' | 'entityId'>
): boolean =>
  a.entityId !== undefined || b.entityId !== undefined
    ? a.entityId === b.entityId
    : a.type === b.type && a.path === b.path

/** History entry for a tab currently in the group, or `null` if it is gone. */
const entryForTab = (group: TabGroup, tabId: string | null): TabHistoryEntry | null => {
  if (!tabId) return null
  const tab = group.tabs.find((t) => t.id === tabId)
  return tab ? { tabId, content: snapshotTabContent(tab) } : null
}

/**
 * Push the outgoing tab onto `back`, clear `forward`, and set the new active id.
 * No-op if the active id is unchanged. Use this whenever a tab becomes active
 * via user-initiated navigation (open, click) — but NOT during NAV_BACK/NAV_FORWARD,
 * which manage the stacks directly.
 */
export const recordActivation = (group: TabGroup, newActiveId: string | null): TabGroup => {
  if (group.activeTabId === newActiveId) return group
  const outgoing = entryForTab(group, group.activeTabId)
  return {
    ...group,
    back: outgoing ? cap([...group.back, outgoing]) : group.back,
    forward: [],
    activeTabId: newActiveId
  }
}

/**
 * Record a navigation that REPLACES a tab's contents instead of changing tabs.
 *
 * This is the half `recordActivation` structurally cannot see: `replaceActive`
 * and `reuseActiveTab` keep the tab's id, so the active id never changes and
 * nothing was ever pushed — back and forward simply did nothing after opening a
 * note in the same tab (#2207).
 *
 * `previous` is the tab as it stood BEFORE the swap, so its snapshot carries the
 * scroll offsets saved against the outgoing entity.
 */
export const recordSameTabNavigation = (
  group: TabGroup,
  previous: Tab,
  next: Pick<Tab, 'type' | 'path' | 'entityId'>
): TabGroup => {
  if (isSameDestination(previous, next)) return group
  return {
    ...group,
    back: cap([...group.back, { tabId: previous.id, content: snapshotTabContent(previous) }]),
    forward: []
  }
}

/** Append the group's current position to a stack, bounded. */
export const pushCurrentPosition = (
  group: TabGroup,
  stack: TabHistoryEntry[]
): TabHistoryEntry[] => {
  const current = entryForTab(group, group.activeTabId)
  return current ? cap([...stack, current]) : stack
}

/**
 * Put a history entry's content back into its tab.
 *
 * Skipped when the tab already shows that destination: the entry can be older
 * than the tab's live title or scroll (a plain tab switch leaves both stale),
 * and rewriting would revert a rename or clobber a fresher offset. Flags that
 * describe the tab rather than the content — `isPinned` — survive; the ones
 * that describe the OLD content are reset exactly as OPEN_TAB resets them.
 */
export const restoreHistoryEntry = (tabs: Tab[], entry: TabHistoryEntry): Tab[] => {
  const index = tabs.findIndex((t) => t.id === entry.tabId)
  if (index === -1) return tabs
  const tab = tabs[index]
  if (isSameDestination(tab, entry.content)) return tabs

  const restored: Tab = {
    ...tab,
    ...entry.content,
    id: tab.id,
    isPinned: tab.isPinned,
    isModified: false,
    isPreview: false,
    isDeleted: false,
    openedAt: tab.openedAt
  }
  const next = [...tabs]
  next[index] = restored
  return next
}

/**
 * Remove a set of tab ids from both history stacks of a group. Used when tabs
 * are closed or moved out so stale ids don't surface during back/forward navigation.
 */
export const pruneHistory = (group: TabGroup, removedIds: Set<string>): TabGroup => {
  if (removedIds.size === 0) return group
  const back = group.back.filter((e) => !removedIds.has(e.tabId))
  const forward = group.forward.filter((e) => !removedIds.has(e.tabId))
  if (back.length === group.back.length && forward.length === group.forward.length) return group
  return { ...group, back, forward }
}

/**
 * Drop every history entry showing an entity that no longer exists.
 *
 * Closing the tabs on a deleted entity is not enough once history carries
 * content: an entry snapshotted before the delete would navigate a surviving
 * tab straight onto a tombstone.
 */
export const pruneHistoryByEntity = (group: TabGroup, entityId: string): TabGroup => {
  const back = group.back.filter((e) => e.content.entityId !== entityId)
  const forward = group.forward.filter((e) => e.content.entityId !== entityId)
  if (back.length === group.back.length && forward.length === group.forward.length) return group
  return { ...group, back, forward }
}
