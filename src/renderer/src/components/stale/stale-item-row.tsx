import { Link, FileText, Image, Mic, Scissors, FileIcon, Share2 } from 'lucide-react'

import { Checkbox } from '@/components/ui/checkbox'
import { QuickActions } from '@/components/quick-actions'
import { AgeIndicator } from '@/components/stale/age-indicator'
import { formatTimestamp } from '@/lib/inbox-utils'
import { cn } from '@/lib/utils'
import { type DisplayDensity, DENSITY_CONFIG } from '@/hooks/use-display-density'
import type { InboxItemListItem, InboxItemType } from '@/types'

// Type alias for convenience (backend type)
type InboxItem = InboxItemListItem

// Icon component based on item type
const TypeIcon = ({ type }: { type: InboxItemType }): React.JSX.Element => {
  const iconClass = 'size-4 text-[var(--muted-foreground)]'

  switch (type) {
    case 'link':
      return <Link className={iconClass} aria-hidden="true" />
    case 'note':
      return <FileText className={iconClass} aria-hidden="true" />
    case 'image':
      return <Image className={iconClass} aria-hidden="true" />
    case 'voice':
      return <Mic className={iconClass} aria-hidden="true" />
    case 'clip':
      return <Scissors className={iconClass} aria-hidden="true" />
    case 'pdf':
      return <FileIcon className={iconClass} aria-hidden="true" />
    case 'social':
      return <Share2 className={iconClass} aria-hidden="true" />
    default:
      return <FileText className={iconClass} aria-hidden="true" />
  }
}

interface StaleItemRowProps {
  item: InboxItem
  isFocused: boolean
  isSelected: boolean
  isInBulkMode: boolean
  isExiting?: boolean
  density?: DisplayDensity
  onArchive: (id: string) => void
  onFocus: (id: string) => void
  onSelectionToggle: (id: string, shiftKey: boolean) => void
}

/**
 * Row component for stale items - includes age indicator below the title
 */
export const StaleItemRow = ({
  item,
  isFocused,
  isSelected,
  isInBulkMode,
  isExiting = false,
  density = 'comfortable',
  onArchive,
  onFocus,
  onSelectionToggle
}: StaleItemRowProps): React.JSX.Element => {
  const densityConfig = DENSITY_CONFIG[density]
  const handleClick = (): void => {
    onFocus(item.id)
  }

  const handleCheckboxClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onSelectionToggle(item.id, e.shiftKey)
  }

  const handleCheckboxChange = (_checked: boolean | 'indeterminate'): void => {
    // Handled in handleCheckboxClick for shift-key support
  }

  return (
    <div
      className={cn(
        'group relative flex flex-col gap-0.5 cursor-pointer',
        densityConfig.itemPadding,
        densityConfig.itemRadius,
        'transition-[background-color,box-shadow] duration-150 ease-out',
        // Exit animation
        isExiting
          ? 'opacity-0 scale-95 -translate-y-1 motion-reduce:opacity-0 motion-reduce:scale-100 motion-reduce:translate-y-0'
          : 'opacity-100 scale-100 translate-y-0',
        // Selection/focus states (using ring-inset to prevent layout shift)
        isSelected
          ? 'bg-primary/10 ring-1 ring-inset ring-primary/30'
          : isFocused
            ? 'bg-amber-500/10 ring-2 ring-inset ring-amber-500/50'
            : 'hover:bg-amber-500/5'
      )}
      role="listitem"
      tabIndex={isFocused ? 0 : -1}
      aria-label={`${item.type}: ${item.title}`}
      aria-selected={isSelected}
      onClick={handleClick}
      data-item-id={item.id}
    >
      {/* Top row: checkbox, icon, title, timestamp */}
      <div className={cn('flex items-center', densityConfig.itemGap)}>
        {/* Checkbox */}
        <Checkbox
          id={`stale-item-${item.id}`}
          checked={isSelected}
          onCheckedChange={handleCheckboxChange}
          className={cn(
            'shrink-0 transition-opacity duration-150',
            isSelected
              ? 'opacity-100'
              : isInBulkMode
                ? 'opacity-80'
                : isFocused
                  ? 'opacity-100'
                  : 'opacity-60 group-hover:opacity-100'
          )}
          aria-label={`Select ${item.title}`}
          onClick={handleCheckboxClick}
        />

        {/* Type Icon */}
        <TypeIcon type={item.type} />

        {/* Title */}
        <span className="flex-1 text-sm text-[var(--foreground)] truncate min-w-0">
          {item.title}
        </span>

        {/* Timestamp & Quick Actions container - fixed width to prevent layout shift */}
        <div className="relative shrink-0 flex items-center">
          {/* Timestamp - fades out on hover or when focused */}
          <span
            className={cn(
              'text-xs text-muted-foreground tabular-nums transition-opacity duration-100',
              isInBulkMode ? '' : isFocused ? 'opacity-0' : 'group-hover:opacity-0'
            )}
          >
            {formatTimestamp(item.createdAt, 'OLDER')}
          </span>

          {/* Quick Actions - absolutely positioned over timestamp, visible on hover or when focused */}
          {!isInBulkMode && (
            <div
              className={cn(
                'absolute right-0 top-1/2 -translate-y-1/2 flex transition-opacity duration-100',
                isFocused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
            >
              <QuickActions itemId={item.id} onArchive={onArchive} variant="row" />
            </div>
          )}
        </div>
      </div>

      {/* Bottom row: Age indicator */}
      <div className="ml-11">
        <AgeIndicator item={item} />
      </div>
    </div>
  )
}
