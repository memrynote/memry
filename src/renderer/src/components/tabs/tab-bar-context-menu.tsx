/**
 * Tab Bar Context Menu
 * Right-click context menu for empty tab bar area
 */

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useTabs } from '@/contexts/tabs'

interface TabBarContextMenuProps {
  /** Group ID for this tab bar */
  groupId: string
  /** Children to wrap */
  children: React.ReactNode
}

/**
 * Context menu for tab bar empty area (new tab, close all, etc.)
 */
export const TabBarContextMenu = ({
  groupId,
  children
}: TabBarContextMenuProps): React.JSX.Element => {
  const { openTab, closeAllTabs } = useTabs()

  // Handlers
  const handleNewTab = (): void => {
    openTab(
      {
        type: 'inbox',
        title: 'Inbox',
        icon: 'inbox',
        path: '/inbox',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      },
      { groupId }
    )
  }

  const handleCloseAll = (): void => {
    closeAllTabs(groupId)
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={handleNewTab}>
          New Tab
          <ContextMenuShortcut>⌘T</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onClick={handleCloseAll}>Close All Tabs</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export default TabBarContextMenu
