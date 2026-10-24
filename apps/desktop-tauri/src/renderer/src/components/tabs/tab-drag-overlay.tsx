/**
 * Tab Drag Overlay
 * Visual representation of tab being dragged
 */

import type { Tab } from '@/contexts/tabs/types'
import { TabIcon } from './tab-icon'
import { cn } from '@/lib/utils'

interface TabDragOverlayProps {
  /** Tab data being dragged */
  tab: Tab
}

/**
 * Overlay component shown while dragging a tab
 * Browser-style with elevated appearance
 */
export const TabDragOverlay = ({ tab }: TabDragOverlayProps): React.JSX.Element => {
  return (
    <div
      className={cn(
        'flex items-center gap-2 h-9 px-4',
        'min-w-[var(--tab-w-min)] max-w-[var(--tab-w-max)]',
        'select-none pointer-events-none',
        'rounded',
        'bg-sidebar-terracotta/[0.07]',
        'border border-dashed border-sidebar-terracotta/25',
        'shadow-sm'
      )}
    >
      <TabIcon
        type={tab.type}
        icon={tab.icon}
        emoji={tab.emoji}
        entityId={tab.entityId}
        className="w-4 h-4 flex-shrink-0 text-sidebar-terracotta"
      />

      <span className={cn('flex-1 truncate text-[13px] font-normal', 'text-sidebar-terracotta')}>
        {tab.title}
      </span>

      {tab.isModified && (
        <div className="w-1.5 h-1.5 rounded-full bg-sidebar-terracotta flex-shrink-0" />
      )}
    </div>
  )
}

export default TabDragOverlay
