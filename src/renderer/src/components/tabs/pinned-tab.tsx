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
            // Base styles
            'relative flex items-center justify-center',
            'w-9 h-9 cursor-pointer',
            'transition-colors duration-100',
            'select-none',

            // Active state - browser style with rounded top corners
            isActive
              ? [
                  'bg-white dark:bg-gray-800',
                  'rounded-t-lg',
                  'border border-gray-200 dark:border-gray-600',
                  'border-b-0',
                  '-mb-px'
                ]
              : ['hover:bg-gray-200/50 dark:hover:bg-gray-700/50'],

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
          {/* Icon */}
          <TabIcon
            type={tab.type}
            icon={tab.icon}
            emoji={tab.emoji}
            className={cn(
              'w-4 h-4',
              isActive ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'
            )}
          />

          {/* Modified indicator (small dot) */}
          {tab.isModified && (
            <div
              className={cn('absolute top-1 right-1', 'w-1.5 h-1.5 rounded-full', 'bg-blue-500')}
              aria-label="Unsaved changes"
            />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        <div className="flex items-center gap-1.5">
          <span>{tab.title}</span>
          {tab.isModified && <span className="text-gray-400">(unsaved)</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

export default PinnedTab
