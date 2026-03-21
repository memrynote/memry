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
            'relative flex items-center justify-center',
            'w-9 h-9 cursor-pointer',
            'select-none',
            'border-r border-r-border/40',
            'border-b-2',
            'transition-colors duration-150 ease-out',

            isActive
              ? ['bg-background', 'border-b-sidebar-terracotta']
              : ['bg-transparent', 'border-b-transparent', 'hover:bg-foreground/[0.03]'],

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
              isActive ? 'text-foreground' : 'text-text-tertiary hover:text-text-secondary'
            )}
          />

          {/* Modified indicator with pulse animation */}
          {tab.isModified && (
            <div
              className={cn(
                'absolute top-1 right-1',
                'w-1.5 h-1.5 rounded-full',
                'bg-tint',
                'animate-pulse'
              )}
              aria-label="Unsaved changes"
            />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        className="text-xs px-2.5 py-1.5 font-medium bg-primary text-primary-foreground border-0"
      >
        <div className="flex items-center gap-1.5">
          <span>{tab.title}</span>
          {tab.isModified && <span className="text-muted-foreground">(unsaved)</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

export default PinnedTab
