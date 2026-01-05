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
 * Features elevated styling with smooth visual feedback
 */
export const TabDragOverlay = ({ tab }: TabDragOverlayProps): React.JSX.Element => {
  return (
    <div
      className={cn(
        // Base styles matching refined RegularTab
        'flex items-center gap-2 h-8 px-3',
        'min-w-[100px] max-w-[180px]',
        'select-none pointer-events-none',
        'rounded-md',
        // Elevated floating appearance
        'bg-white dark:bg-gray-800',
        'border border-gray-200/80 dark:border-gray-600/60',
        // Prominent shadow for "lifted" effect
        'shadow-[0_8px_30px_rgba(0,0,0,0.12),0_4px_12px_rgba(0,0,0,0.08)]',
        'dark:shadow-[0_8px_30px_rgba(0,0,0,0.4),0_4px_12px_rgba(0,0,0,0.3)]',
        // Slight scale up for emphasis
        'scale-[1.02]',
        // Accent indicator
        'ring-2 ring-blue-400/50 dark:ring-blue-500/40',
        // Smooth appearance
        'backdrop-blur-sm'
      )}
    >
      {/* Icon */}
      <TabIcon
        type={tab.type}
        icon={tab.icon}
        emoji={tab.emoji}
        className="w-4 h-4 flex-shrink-0 text-gray-700 dark:text-gray-200"
      />

      {/* Title with refined typography */}
      <span
        className={cn(
          'flex-1 truncate text-[13px] font-medium tracking-[-0.01em]',
          'text-gray-800 dark:text-gray-100',
          tab.isPreview && 'italic font-normal'
        )}
      >
        {tab.title}
      </span>

      {/* Modified indicator */}
      {tab.isModified && (
        <div className="w-1.5 h-1.5 rounded-full bg-blue-400 dark:bg-blue-500 flex-shrink-0" />
      )}
    </div>
  )
}

export default TabDragOverlay
