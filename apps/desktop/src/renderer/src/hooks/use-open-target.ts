/**
 * Open Target Hook
 *
 * The single place that knows how to open a tab somewhere other than "here":
 * in a genuinely new tab, or in the pane beside the current one.
 *
 * It exists because the sidebar has two different callers. Nav items go through
 * `useSidebarNavigation` with a `SidebarItem`; note, folder, canvas, project and
 * tag rows build tab data and call `openTab` directly. Both need the same two
 * gestures, and both would otherwise have to remember that SPLIT_VIEW leaves
 * `activeGroupId` on the source pane — a detail that is wrong four times as
 * often as it is copied correctly.
 */

import { useCallback, useEffect, useRef } from 'react'
import { useTabActions, useTabs } from '@/contexts/tabs'
import type { OpenTabOptions, Tab } from '@/contexts/tabs/types'
import { getSiblingGroupId } from '@/components/split-view/layout-helpers'
import { useGeneralSettings } from '@/hooks/use-general-settings'

/** Tab data as the callers build it, before the reducer stamps id/timestamps. */
export type OpenTargetTab = Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>

export interface OpenTargetOptions {
  /** Open without stealing focus (middle-click). */
  background?: boolean
}

/**
 * The "clicking a page opens a new tab" preference (#1644), as open options.
 *
 * `openPage` is what a plain click/activation calls: with the preference on it
 * behaves exactly like `openTab`; with it off it asks the reducer to reuse the
 * active tab. The reducer runs that request only after every dedup branch, so a
 * page that is already open still just gets focused, and it never touches a
 * pinned tab. Explicit gestures — "Open in New Tab", "Open to the Side",
 * middle-click — do not go through here: stated intent beats the preference.
 */
export const useOpenPage = () => {
  const { openTab } = useTabActions()
  const { settings } = useGeneralSettings()
  const reuseActiveTab = !settings.openPagesInNewTab

  const openPage = useCallback(
    (tab: OpenTargetTab, options?: OpenTabOptions) => {
      // With the preference on and nothing else to say, openPage IS openTab —
      // no options object, so call sites and their tests read identically.
      if (!reuseActiveTab && !options) {
        openTab(tab)
        return
      }
      openTab(tab, { reuseActiveTab, ...options })
    },
    [openTab, reuseActiveTab]
  )

  return { openPage, reuseActiveTab }
}

export const useOpenTarget = () => {
  const { openTab, splitView } = useTabActions()
  const { state } = useTabs()

  // Same ref pattern as useSidebarNavigation: keeps both callbacks stable so a
  // menu row does not re-render every sidebar item on each tab-state change.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })

  /**
   * Open in a second tab in the current pane, beside whatever is already there.
   *
   * `forceNew` is what makes this differ from a plain click: without it, OPEN_TAB
   * finds the entity already open — in this pane or another — and just focuses
   * it. That includes singletons: a second Home or Inbox in the same pane is a
   * deliberate duplicate (#1644), no longer declined.
   */
  const openInNewTab = useCallback(
    (tab: OpenTargetTab, options: OpenTargetOptions = {}) => {
      openTab(tab, { forceNew: true, background: options.background })
    },
    [openTab]
  )

  /**
   * Open in the pane beside this one, splitting only if there is no pane to use.
   *
   * Reusing the sibling is what keeps the layout from growing a pane per
   * menu invocation. Passing an explicit `groupId` also turns off OPEN_TAB's
   * cross-group dedup, so the tab lands in the pane we asked for instead of
   * focusing the copy in the pane we are trying to open *away* from — while
   * per-group dedup still focuses it if that pane already has it.
   */
  const openToTheSide = useCallback(
    (tab: OpenTargetTab, options: OpenTargetOptions = {}) => {
      const current = stateRef.current
      const sibling = getSiblingGroupId(current.layout, current.activeGroupId)

      if (sibling) {
        openTab(tab, { groupId: sibling, background: options.background })
        return
      }

      const newGroupId = splitView('horizontal', current.activeGroupId, {
        cloneActiveTab: false
      })
      openTab(tab, { groupId: newGroupId ?? undefined, background: options.background })
    },
    [openTab, splitView]
  )

  return { openInNewTab, openToTheSide }
}

export default useOpenTarget
