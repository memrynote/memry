/**
 * Sortable Tab Component
 * Wrapper that enables drag-to-reorder functionality for tabs
 */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Tab } from '@/contexts/tabs/types'
import { RegularTab } from './regular-tab'
import { TabContextMenu } from './tab-context-menu'
import { cn } from '@/lib/utils'

interface SortableTabProps {
  /** Tab data */
  tab: Tab
  /** Group ID this tab belongs to */
  groupId: string
  /** Whether this is the active tab */
  isActive: boolean
}

/**
 * Sortable wrapper for RegularTab with dnd-kit integration and context menu
 */
export const SortableTab = ({ tab, groupId, isActive }: SortableTabProps): React.JSX.Element => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({
      id: tab.id,
      data: {
        type: 'tab',
        tab,
        groupId
      }
    })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 150ms cubic-bezier(0.25, 1, 0.5, 1)',
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 1000 : 'auto'
  }

  return (
    <TabContextMenu tab={tab} groupId={groupId}>
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'relative',
          // Smooth opacity transition when dragging
          'transition-opacity duration-150 ease-out',
          // Enhanced drop indicator with glow effect
          isOver && [
            'before:absolute before:-left-0.5 before:top-2 before:bottom-2',
            'before:w-0.5 before:bg-sidebar-terracotta before:rounded-full'
          ]
        )}
        {...attributes}
        {...listeners}
      >
        <RegularTab
          tab={tab}
          groupId={groupId}
          isActive={isActive}
          className={cn(
            isDragging && 'opacity-40 scale-[0.98]',
            'transition-all duration-150 ease-out'
          )}
        />
      </div>
    </TabContextMenu>
  )
}

export default SortableTab
