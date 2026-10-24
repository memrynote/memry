/**
 * Keeps the Home tab's title on the name of the board it is showing.
 *
 * A tab's title is a SNAPSHOT taken when the tab opens (`createDefaultTab`
 * stamps the literal `'Home'`), so switching to another board, or renaming the
 * one already open, left the tab reading `Home` for every board there is.
 *
 * It lives here, above the tab tree, rather than in the Home page: only the
 * ACTIVE tab is mounted, so a page-level effect would go silent the moment the
 * user looked at anything else — and a board renamed on another device arrives
 * by sync while the Home tab sits in the background.
 *
 * Diffing shape rather than the event-driven one `CanvasTabTitleSync` uses: the
 * board list is already in memory as a query, so there is nothing to hold a
 * second copy of, and one derived title covers every route a rename can take
 * (the board manager, a peer's write, a board being deleted out from under the
 * selection) without a subscription per route.
 *
 * The default board is named `home.board.defaultName` — "Home" — when it is
 * seeded, so an untouched install keeps reading "Home" and only a real rename
 * changes it. That same string is the fallback for a session that has no board
 * at all, which is what a tab persisted by an older build carries anyway.
 *
 * @module components/tabs/home-tab-title-sync
 */

import { useEffect } from 'react'

import { useTabs } from '@/contexts/tabs'
import { useHomeBoards } from '@/hooks/use-home-boards'
import { useT } from '@memry/i18n/renderer'

export function HomeTabTitleSync(): null {
  const { activeBoard, isLoading } = useHomeBoards()
  const { state, updateTabTitle } = useTabs()
  const { t } = useT('common')
  const tabGroups = state?.tabGroups

  useEffect(() => {
    // Retitling from the empty list the query starts on would overwrite a
    // restored title with the fallback and then flip it back a tick later.
    if (isLoading || !tabGroups) return
    const title = activeBoard?.name?.trim() || t('home.board.defaultName')
    for (const [groupId, group] of Object.entries(tabGroups)) {
      for (const tab of group.tabs) {
        // Skipping a tab that already reads `title` is what keeps a widget
        // autosave — which invalidates the same query — from re-rendering the
        // tab tree and re-arming the debounced write of tab state to disk.
        if (tab.type !== 'home' || tab.title === title) continue
        updateTabTitle(tab.id, title, groupId)
      }
    }
  }, [activeBoard, isLoading, t, tabGroups, updateTabTitle])

  return null
}

export default HomeTabTitleSync
