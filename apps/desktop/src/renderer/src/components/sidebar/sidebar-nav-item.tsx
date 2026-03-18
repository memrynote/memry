/**
 * Sidebar Navigation Item
 * Sidebar item component with tab integration
 */

import { useMemo, useCallback } from 'react'
import type { SidebarItem } from '@/contexts/tabs/types'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { SidebarItemContextMenu } from './sidebar-item-context-menu'
import { TabIcon } from '@/components/tabs/tab-icon'
import { cn } from '@/lib/utils'

interface SidebarNavItemProps {
  /** Sidebar item data */
  item: SidebarItem
  /** Nesting depth for indentation */
  depth?: number
  /** Whether this item is currently selected (keyboard nav) */
  isSelected?: boolean
  /** Optional callback for edit action */
  onEdit?: () => void
  /** Optional callback for delete action */
  onDelete?: () => void
  /** Additional CSS classes */
  className?: string
}

/**
 * Sidebar navigation item with click handlers and context menu
 */
export const SidebarNavItem = ({
  item,
  depth = 0,
  isSelected = false,
  onEdit,
  onDelete,
  className
}: SidebarNavItemProps): React.JSX.Element => {
  const { openSidebarItem, isOpenInTab, isActiveItem, settings } = useSidebarNavigation()

  // Check if this item is open in any tab
  const isOpenTab = useMemo(() => isOpenInTab(item), [isOpenInTab, item])

  // Check if this item is the active tab
  const isActive = useMemo(() => isActiveItem(item), [isActiveItem, item])

  // Handle single click
  const handleClick = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault()

      // Check for modifier keys
      const inNewTab = e.metaKey || e.ctrlKey
      const inBackground = e.shiftKey && inNewTab

      // Single click with preview mode = preview tab (unless modifier)
      const isPreview = settings.previewMode && !inNewTab

      openSidebarItem(item, { inNewTab, inBackground, isPreview })
    },
    [openSidebarItem, item, settings.previewMode]
  )

  // Handle middle click
  const handleMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      if (e.button === 1) {
        // Middle click
        e.preventDefault()
        openSidebarItem(item, { inNewTab: true, inBackground: true })
      }
    },
    [openSidebarItem, item]
  )

  // Handle double click - always permanent tab
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault()
      openSidebarItem(item, { isPreview: false })
    },
    [openSidebarItem, item]
  )

  return (
    <SidebarItemContextMenu item={item} onEdit={onEdit} onDelete={onDelete}>
      <button
        type="button"
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        className={cn(
          // Base styles
          'group relative w-full flex items-center gap-2 py-1.5 rounded-md text-sm',
          'transition-colors duration-100 cursor-pointer',
          'outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1',

          'hover:bg-muted',

          isActive && ['bg-sidebar-accent', 'text-sidebar-accent-foreground', 'font-medium'],

          isSelected && !isActive && 'bg-muted',

          isOpenTab && !isActive && 'text-sidebar-accent-foreground',

          className
        )}
        style={{ paddingLeft: `${8 + depth * 16}px`, paddingRight: '8px' }}
        data-item-id={item.id}
        data-item-type={item.type}
      >
        {/* Active indicator bar */}
        {isActive && (
          <div className="absolute left-0 top-1 bottom-1 w-0.5 rounded-r bg-sidebar-accent-foreground" />
        )}

        {/* Color dot for projects */}
        {item.color && (
          <div
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: item.color }}
          />
        )}

        {/* Icon */}
        {!item.color && (
          <TabIcon
            type={item.type}
            icon={item.icon}
            className={cn(
              'w-4 h-4 flex-shrink-0',
              isActive ? 'text-sidebar-accent-foreground' : 'text-muted-foreground'
            )}
          />
        )}

        {/* Title */}
        <span className="flex-1 truncate text-left">{item.title}</span>

        {/* Count badge */}
        {item.count !== undefined && item.count > 0 && (
          <span
            className={cn(
              'text-xs tabular-nums',
              isActive ? 'text-sidebar-accent-foreground' : 'text-text-tertiary'
            )}
          >
            {item.count}
          </span>
        )}

        {/* Open in tab indicator dot */}
        {isOpenTab && !isActive && (
          <div className="w-1.5 h-1.5 rounded-full bg-sidebar-accent-foreground flex-shrink-0" />
        )}
      </button>
    </SidebarItemContextMenu>
  )
}

export default SidebarNavItem
