import { AlertTriangle } from 'lucide-react'

import { StaleItemRow } from '@/components/stale/stale-item-row'
import { StaleActionFooter } from '@/components/stale/stale-action-footer'
import { STALE_THRESHOLD_DAYS } from '@/lib/stale-utils'
import { cn } from '@/lib/utils'
import { type DisplayDensity, DENSITY_CONFIG } from '@/hooks/use-display-density'
import type { InboxItemListItem } from '@/types'

// Type alias for convenience (backend type)
type InboxItem = InboxItemListItem

interface StaleSectionHeaderProps {
  itemCount: number
  threshold?: number
}

/**
 * Header for the stale section showing count and threshold
 */
const StaleSectionHeader = ({
  itemCount,
  threshold = STALE_THRESHOLD_DAYS
}: StaleSectionHeaderProps): React.JSX.Element => {
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-amber-500/20">
      <AlertTriangle className="size-4 text-amber-500" aria-hidden="true" />
      <h2 className="text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
        Needs attention
      </h2>
      <span className="text-xs text-[var(--muted-foreground)]">
        · {itemCount} item{itemCount !== 1 ? 's' : ''} older than {threshold} days
      </span>
    </div>
  )
}

interface StaleSectionProps {
  items: InboxItem[]
  selectedItemIds: Set<string>
  exitingItemIds?: Set<string>
  focusedItemId: string | null
  density?: DisplayDensity
  onArchive: (id: string) => void
  onFocus: (id: string) => void
  onSelectionToggle: (id: string, shiftKey: boolean) => void
  onFileAllToUnsorted: () => void
  onReviewOneByOne: () => void
  className?: string
}

/**
 * Complete stale items section with header, items, and action footer
 */
export const StaleSection = ({
  items,
  selectedItemIds,
  exitingItemIds = new Set(),
  focusedItemId,
  density = 'comfortable',
  onArchive,
  onFocus,
  onSelectionToggle,
  onFileAllToUnsorted,
  onReviewOneByOne,
  className
}: StaleSectionProps): React.JSX.Element | null => {
  const densityConfig = DENSITY_CONFIG[density]
  if (items.length === 0) {
    return null
  }

  const isInBulkMode = selectedItemIds.size > 0

  return (
    <section
      className={cn(
        'border border-amber-500/20 bg-amber-500/5 dark:bg-amber-500/5',
        densityConfig.itemRadius,
        densityConfig.captureMargin,
        'animate-in fade-in duration-300',
        className
      )}
      aria-labelledby="stale-section-header"
    >
      {/* Section Header */}
      <StaleSectionHeader itemCount={items.length} />

      {/* Items */}
      <div className="p-2">
        <div className="space-y-0.5">
          {items.map((item) => (
            <StaleItemRow
              key={item.id}
              item={item}
              isFocused={focusedItemId === item.id}
              isSelected={selectedItemIds.has(item.id)}
              isInBulkMode={isInBulkMode}
              isExiting={exitingItemIds.has(item.id)}
              density={density}
              onArchive={onArchive}
              onFocus={onFocus}
              onSelectionToggle={onSelectionToggle}
            />
          ))}
        </div>
      </div>

      {/* Action Footer */}
      <StaleActionFooter
        itemCount={items.length}
        onFileAllToUnsorted={onFileAllToUnsorted}
        onReviewOneByOne={onReviewOneByOne}
      />
    </section>
  )
}

export { StaleSectionHeader }
