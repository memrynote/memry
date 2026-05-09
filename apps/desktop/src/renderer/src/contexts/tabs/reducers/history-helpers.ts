import type { TabGroup } from '../types'

export const HISTORY_LIMIT = 50

const cap = (ids: string[]): string[] =>
  ids.length > HISTORY_LIMIT ? ids.slice(-HISTORY_LIMIT) : ids

/**
 * Push the previous active tab id onto `back`, clear `forward`, and set the new active id.
 * No-op if the active id is unchanged. Use this whenever a tab becomes active
 * via user-initiated navigation (open, click) — but NOT during NAV_BACK/NAV_FORWARD,
 * which manage the stacks directly.
 */
export const recordActivation = (group: TabGroup, newActiveId: string | null): TabGroup => {
  if (group.activeTabId === newActiveId) return group
  const back = group.activeTabId ? cap([...group.back, group.activeTabId]) : group.back
  return {
    ...group,
    back,
    forward: [],
    activeTabId: newActiveId
  }
}

/**
 * Remove a set of tab ids from both history stacks of a group. Used when tabs
 * are closed or moved out so stale ids don't surface during back/forward navigation.
 */
export const pruneHistory = (group: TabGroup, removedIds: Set<string>): TabGroup => {
  if (removedIds.size === 0) return group
  const back = group.back.filter((id) => !removedIds.has(id))
  const forward = group.forward.filter((id) => !removedIds.has(id))
  if (back.length === group.back.length && forward.length === group.forward.length) return group
  return { ...group, back, forward }
}
