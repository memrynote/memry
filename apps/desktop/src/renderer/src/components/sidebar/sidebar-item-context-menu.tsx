/**
 * Sidebar Item Context Menu
 * Right-click context menu for sidebar navigation items
 */

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import type { SidebarItem } from '@/contexts/tabs/types'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'

interface SidebarItemContextMenuProps {
  /** Sidebar item data */
  item: SidebarItem
  /** Children to wrap */
  children: React.ReactNode
  /** Optional callback for edit action */
  onEdit?: () => void
  /** Optional callback for delete action */
  onDelete?: () => void
}

/**
 * Context menu for sidebar items (Open, Open in New Tab, etc.)
 */
export const SidebarItemContextMenu = ({
  item,
  children,
  onEdit,
  onDelete
}: SidebarItemContextMenuProps): React.JSX.Element => {
  const { openSidebarItem, openAsPin, copyItemLink } = useSidebarNavigation()

  // Determine if this item is editable
  const isEditable = ['project', 'note', 'collection', 'journal'].includes(item.type)

  // Handlers
  const handleOpen = (): void => {
    openSidebarItem(item)
  }

  const handleOpenInNewTab = (): void => {
    openSidebarItem(item, { inNewTab: true })
  }

  const handleOpenToTheSide = (): void => {
    openSidebarItem(item, { toTheSide: true })
  }

  const handlePinToTabs = (): void => {
    openAsPin(item)
  }

  const handleCopyLink = (): void => {
    copyItemLink(item)
  }

  const handleEdit = (): void => {
    onEdit?.()
  }

  const handleDelete = (): void => {
    onDelete?.()
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {/* Open actions */}
        <ContextMenuItem onClick={handleOpen}>Open</ContextMenuItem>
        <ContextMenuItem onClick={handleOpenInNewTab}>
          Open in New Tab
          <ContextMenuShortcut>⌘↵</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={handleOpenToTheSide}>Open to the Side</ContextMenuItem>

        <ContextMenuSeparator />

        {/* Tab actions */}
        <ContextMenuItem onClick={handlePinToTabs}>Pin to Tabs</ContextMenuItem>

        {/* Edit/Delete for editable items */}
        {isEditable && (onEdit || onDelete) && (
          <>
            <ContextMenuSeparator />
            {onEdit && <ContextMenuItem onClick={handleEdit}>Edit</ContextMenuItem>}
            {onDelete && (
              <ContextMenuItem
                onClick={handleDelete}
                className="text-red-600 focus:text-red-600 focus:bg-red-50"
              >
                Delete
              </ContextMenuItem>
            )}
          </>
        )}

        <ContextMenuSeparator />

        {/* Utility actions */}
        <ContextMenuItem onClick={handleCopyLink}>Copy Link</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export default SidebarItemContextMenu
