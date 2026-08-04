/**
 * Tab Context Menu
 * Native OS context menu for individual tabs
 */

import type { Tab } from '@/contexts/tabs/types'
import { useTabs } from '@/contexts/tabs'
import { useCallback } from 'react'
import { useT } from '@memry/i18n/renderer'

interface TabContextMenuProps {
  /** Tab data */
  tab: Tab
  /** Group ID this tab belongs to */
  groupId: string
  /** Children to wrap */
  children: React.ReactNode
  /** Additional CSS classes for the wrapper element */
  className?: string
}

/**
 * Context menu wrapper that shows a native OS context menu on secondary click
 */
export const TabContextMenu = ({
  tab,
  groupId,
  children,
  className
}: TabContextMenuProps): React.JSX.Element => {
  const { closeTab, closeOtherTabs, closeTabsToRight, closeAllTabs, dispatch, state } = useTabs()
  const { t } = useT('common')

  const group = state.tabGroups[groupId]
  const tabIndex = group?.tabs.findIndex((t) => t.id === tab.id) ?? -1
  const hasTabsToRight = tabIndex < (group?.tabs.length ?? 0) - 1
  const hasOtherTabs = (group?.tabs.length ?? 0) > 1

  const handleContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault()

      const menuItems = [
        { id: 'close', label: t('tabs.contextMenu.close'), accelerator: 'CmdOrCtrl+W' },
        { id: 'close-others', label: t('tabs.contextMenu.closeOthers'), disabled: !hasOtherTabs },
        { id: 'close-right', label: t('tabs.contextMenu.closeToRight'), disabled: !hasTabsToRight },
        { id: 'close-all', label: t('tabs.contextMenu.closeAll') },
        { id: 'sep1', label: '', type: 'separator' as const },
        { id: 'pin', label: tab.isPinned ? t('tabs.unpin') : t('tabs.pin') },
        { id: 'duplicate', label: t('tabs.contextMenu.duplicate') },
        { id: 'sep2', label: '', type: 'separator' as const },
        { id: 'split-right', label: t('tabs.contextMenu.splitRight'), accelerator: 'CmdOrCtrl+\\' },
        { id: 'split-down', label: t('tabs.contextMenu.splitDown') },
        { id: 'sep3', label: '', type: 'separator' as const },
        { id: 'copy-path', label: t('tabs.contextMenu.copyPath') },
        { id: 'reveal', label: t('tabs.contextMenu.revealInSidebar') }
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
            payload: { tabId: tab.id, fromGroupId: groupId, direction: 'down' }
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
      dispatch,
      t
    ]
  )

  return (
    <div className={className} onContextMenu={(...args) => void handleContextMenu(...args)}>
      {children}
    </div>
  )
}

export default TabContextMenu
