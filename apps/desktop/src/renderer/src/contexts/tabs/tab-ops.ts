/**
 * Tab operations shared by the keyboard commands (`TabsCommandBridge`) and the
 * tab context menu. The context menu acts on the tab that was right-clicked, not
 * the active one, so it calls these directly instead of going through a command.
 */

import type { Dispatch } from 'react'
import type { Tab, TabAction } from './types'

export function toggleTabPin(
  dispatch: Dispatch<TabAction>,
  tab: Pick<Tab, 'id' | 'isPinned'>,
  groupId: string
): void {
  dispatch({
    type: tab.isPinned ? 'UNPIN_TAB' : 'PIN_TAB',
    payload: { tabId: tab.id, groupId }
  })
}

export function duplicateTab(dispatch: Dispatch<TabAction>, tab: Tab, groupId: string): void {
  dispatch({
    type: 'OPEN_TAB',
    payload: {
      tab: { ...tab, isPinned: false, isPreview: false, isModified: false },
      groupId,
      // Without forceNew the entity dedup just re-activates this tab.
      forceNew: true
    }
  })
}
