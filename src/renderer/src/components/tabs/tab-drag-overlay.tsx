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
        // Base styles matching browser-style RegularTab
        'flex items-center gap-2 h-9 px-3',
        'min-w-[100px] max-w-[180px]',
        'select-none pointer-events-none',
        // Rounded top corners like active tab
        'rounded-t-lg',
        // Same background as active tab
        'bg-white dark:bg-gray-900',
        // Border on all sides for visibility while dragging
        'border border-gray-200 dark:border-gray-700',
        // Prominent shadow for "lifted" effect
        'shadow-[0_8px_24px_rgba(0,0,0,0.15),0_4px_8px_rgba(0,0,0,0.1)]',
        'dark:shadow-[0_8px_24px_rgba(0,0,0,0.5),0_4px_8px_rgba(0,0,0,0.3)]',
        // Slight scale up for emphasis
        'scale-[1.02]'
      )}
    >
      {/* Icon */}
      <TabIcon
        type={tab.type}
        icon={tab.icon}
        emoji={tab.emoji}
        className="w-4 h-4 flex-shrink-0 text-gray-700 dark:text-gray-200"
      />

      {/* Title */}
      <span
        className={cn(
          'flex-1 truncate text-[13px] font-medium',
          'text-gray-800 dark:text-gray-100',
          tab.isPreview && 'italic font-normal'
        )}
      >
        {tab.title}
      </span>

      {/* Modified indicator */}
      {tab.isModified && (
        <div className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />
      )}
    </div>
  )
}

export default TabDragOverlay
