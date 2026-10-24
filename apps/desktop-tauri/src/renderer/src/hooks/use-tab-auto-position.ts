/**
 * Auto-positioning precedence
 *
 * Several surfaces put themselves somewhere the moment they mount, without
 * being asked: the calendar's time grids jump to "now", the image viewer fits
 * the image to its container, the agent transcript jumps to the newest message.
 * Restoring a tab's position on top of surfaces that do that is a race, and a
 * race resolves differently on a fast machine than on a slow one. So it is
 * settled by ONE rule, written here and applied at every one of those sites:
 *
 *   A position stored by THIS tab wins. Auto-positioning runs only when the tab
 *   has nothing stored for that surface — that is, on first open.
 *
 * Two things follow from it, and both matter:
 *
 * - Auto-positioning is not merely "first render". `useScrollToCurrentTime`
 *   re-runs whenever its range starts or stops containing today, which in week
 *   view happens as the user scrolls the weeks past today. Under this rule the
 *   re-run is suppressed once the tab has a stored offset, so the grid stops
 *   yanking itself back to the current hour while the user is reading.
 * - "Nothing stored" is a real, checkable state, not an absence we guess at.
 *   For a scroller it is "this pane has no restorable entry", read through the
 *   very same predicate the restore uses (`isRestorableEntry`), so the two can
 *   never disagree about whether there is a position. For a value kept in the
 *   tab's `viewState` it is the explicit `null` default — see
 *   `mayAutoPositionFor`.
 *
 * The ONE deliberate exception is the agent transcript, and it is an exception
 * to the mechanism rather than to the rule: "stick to the bottom" is not a
 * position, it is a policy, and it is what the transcript stores when the user
 * is at the bottom. A stored numeric offset — the user having scrolled up —
 * still wins there, exactly like everywhere else.
 */

import { useCallback } from 'react'
import { useTabActionsOptional } from '@/contexts/tabs'
import { isRestorableEntry, readScrollPane } from '@/contexts/tabs/scroll-panes'
import { useTabIdentity } from '@/contexts/tabs/tab-identity'

/**
 * Asked at the moment the surface wants to move itself, not at render time.
 *
 * A getter rather than a boolean on purpose: the answer changes the first time
 * the user scrolls, and the components that auto-position do not subscribe to
 * tab state, so a rendered boolean would go stale exactly when it matters.
 */
export type TabAutoPositionGate = () => boolean

export function useTabAutoPosition(key?: string): TabAutoPositionGate {
  const identity = useTabIdentity()
  // Optional: these surfaces also render outside a tab (the agent side pane,
  // previews, tests), where there is no stored position to defer to.
  const getTab = useTabActionsOptional()?.getTab

  const tabId = identity?.tabId
  const groupId = identity?.groupId
  const entityId = identity?.entityId

  return useCallback(() => {
    if (!tabId || !groupId || !getTab) return true
    return !isRestorableEntry(readScrollPane(getTab(tabId, groupId) ?? undefined, key), entityId)
  }, [tabId, groupId, entityId, key, getTab])
}

/**
 * The `viewState` half of the rule.
 *
 * A surface whose position is a value rather than a scroll offset (the image
 * viewer's zoom, the transcript's stick-to-bottom policy) stores `null` for
 * "the user has not positioned this yet" and gates its own auto-positioning on
 * that. Spelled out here so the rule is greppable from every site that obeys
 * it, and so "nothing stored" cannot quietly become "stored the default".
 */
export const mayAutoPositionFor = (stored: unknown): boolean => stored === null
