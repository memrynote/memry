/**
 * Tab Context Menu
 * Native OS context menu for individual tabs
 */

import type { Tab } from '@/contexts/tabs/types'
import { useTabs } from '@/contexts/tabs'
import { useCallback } from 'react'

interface TabContextMenuProps {
  /** Tab data */
  tab: Tab
  /** Group ID this tab belongs to */
  groupId: string
  /** Children to wrap */
  children: React.ReactNode
}

/**
 * Context menu wrapper that shows a native OS context menu on right-click
 */
export const TabContextMenu = ({
  tab,
  groupId,
  children
}: TabContextMenuProps): React.JSX.Element => {
  const { closeTab, closeOtherTabs, closeTabsToRight, closeAllTabs, dispatch, state } = useTabs()

  const group = state.tabGroups[groupId]
  const tabIndex = group?.tabs.findIndex((t) => t.id === tab.id) ?? -1
  const hasTabsToRight = tabIndex < (group?.tabs.length ?? 0) - 1
  const hasOtherTabs = (group?.tabs.length ?? 0) > 1

  const handleContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault()

      const menuItems = [
        { id: 'close', label: 'Close', accelerator: 'CmdOrCtrl+W' },
        { id: 'close-others', label: 'Close Others', disabled: !hasOtherTabs },
        { id: 'close-right', label: 'Close to the Right', disabled: !hasTabsToRight },
        { id: 'close-all', label: 'Close All' },
        { id: 'sep1', label: '', type: 'separator' as const },
        { id: 'pin', label: tab.isPinned ? 'Unpin Tab' : 'Pin Tab' },
        { id: 'duplicate', label: 'Duplicate Tab' },
        { id: 'sep2', label: '', type: 'separator' as const },
        { id: 'split-right', label: 'Split Right', accelerator: 'CmdOrCtrl+\\' },
        { id: 'split-down', label: 'Split Down' },
        { id: 'sep3', label: '', type: 'separator' as const },
        { id: 'copy-path', label: 'Copy Path' },
        { id: 'reveal', label: 'Reveal in Sidebar' }
      ]

      const selectedId = await window.api.showContextMenu(menuItems)

      switch (selectedId) {
        case 'close':
          closeTab(tab.id, groupId)
          break
        case 'close-others':
          closeOtherTabs(tab.id, groupId)
          break
        case 'close-right':
          closeTabsToRight(tab.id, groupId)
          break
        case 'close-all':
          closeAllTabs(groupId)
          break
        case 'pin':
          dispatch({
            type: tab.isPinned ? 'UNPIN_TAB' : 'PIN_TAB',
            payload: { tabId: tab.id, groupId }
          })
          break
        case 'duplicate':
          dispatch({
            type: 'OPEN_TAB',
            payload: {
              tab: { ...tab, isPinned: false, isPreview: false, isModified: false },
              groupId
            }
          })
          break
        case 'split-right':
          dispatch({
            type: 'MOVE_TAB_TO_NEW_SPLIT',
            payload: { tabId: tab.id, fromGroupId: groupId, direction: 'right' }
          })
          break
        case 'split-down':
          dispatch({
            type: 'MOVE_TAB_TO_NEW_SPLIT',
            payload: { tabId: tab.id, fromGroupId: groupId, direction: 'horizontal' }
          })
          break
        case 'copy-path':
          void navigator.clipboard.writeText(tab.path)
          break
        case 'reveal':
          window.dispatchEvent(
            new CustomEvent('reveal-in-sidebar', {
              detail: { path: tab.path, entityId: tab.entityId }
            })
          )
          break
      }
    },
    [
      tab,
      groupId,
      hasOtherTabs,
      hasTabsToRight,
      closeTab,
      closeOtherTabs,
      closeTabsToRight,
      closeAllTabs,
      dispatch
    ]
  )

  return <div onContextMenu={handleContextMenu}>{children}</div>
}

export default TabContextMenu
