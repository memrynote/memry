/**
 * Pinned Tab Component
 * Compact icon-only tab for pinned items
 */

import type { Tab } from '@/contexts/tabs/types'
import { useTabs } from '@/contexts/tabs'
import { TabIcon } from './tab-icon'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface PinnedTabProps {
  /** Tab data */
  tab: Tab
  /** Group ID this tab belongs to */
  groupId: string
  /** Whether this is the active tab */
  isActive: boolean
  /** Additional CSS classes */
  className?: string
}

/**
 * Pinned tab component - compact icon-only display
 */
export const PinnedTab = ({
  tab,
  groupId,
  isActive,
  className
}: PinnedTabProps): React.JSX.Element => {
  const { setActiveTab, closeTab } = useTabs()

  const handleClick = (): void => {
    setActiveTab(tab.id, groupId)
  }

  const handleMouseDown = (e: React.MouseEvent): void => {
    // Middle-click to close (even pinned tabs)
    if (e.button === 1) {
      e.preventDefault()
      closeTab(tab.id, groupId)
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            // Base styles with refined sizing
            'relative flex items-center justify-center',
            'w-8 h-8 cursor-pointer',
            'select-none',
            'rounded-md',
            // Smooth transitions
            'transition-all duration-150 ease-out',

            // Active state - elevated card style matching RegularTab
            isActive
              ? [
                  'bg-white dark:bg-gray-800',
                  'shadow-[0_1px_3px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.06)]',
                  'dark:shadow-[0_1px_3px_rgba(0,0,0,0.3),0_1px_2px_rgba(0,0,0,0.2)]',
                  'border border-gray-200/60 dark:border-gray-700/50'
                ]
              : [
                  'bg-transparent',
                  'hover:bg-gray-200/40 dark:hover:bg-gray-700/30',
                  'border border-transparent',
                  'hover:border-gray-200/40 dark:hover:border-gray-700/30'
                ],

            className
          )}
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          role="tab"
          aria-selected={isActive}
          tabIndex={isActive ? 0 : -1}
          data-tab-id={tab.id}
          data-group-id={groupId}
          data-pinned="true"
        >
          {/* Icon with smooth color transition */}
          <TabIcon
            type={tab.type}
            icon={tab.icon}
            emoji={tab.emoji}
            className={cn(
              'w-4 h-4 transition-colors duration-150',
              isActive
                ? 'text-gray-700 dark:text-gray-200'
                : 'text-gray-400 dark:text-gray-500 hover:text-gray-500 dark:hover:text-gray-400'
            )}
          />

          {/* Modified indicator with pulse animation */}
          {tab.isModified && (
            <div
              className={cn(
                'absolute top-1 right-1',
                'w-1.5 h-1.5 rounded-full',
                'bg-blue-400 dark:bg-blue-500',
                'animate-pulse'
              )}
              aria-label="Unsaved changes"
            />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        className="text-xs px-2.5 py-1.5 font-medium bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 border-0"
      >
        <div className="flex items-center gap-1.5">
          <span>{tab.title}</span>
          {tab.isModified && <span className="text-gray-400 dark:text-gray-500">(unsaved)</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

export default PinnedTab
