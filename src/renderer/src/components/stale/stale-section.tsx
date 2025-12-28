import { AlertTriangle } from 'lucide-react'

import { StaleItemRow } from '@/components/stale/stale-item-row'
import { StaleCard } from '@/components/stale/stale-card'
import { StaleActionFooter } from '@/components/stale/stale-action-footer'
import { STALE_THRESHOLD_DAYS } from '@/lib/stale-utils'
import { cn } from '@/lib/utils'
import type { InboxItemListItem } from '@/types'

// Type alias for convenience (backend type)
type InboxItem = InboxItemListItem

type ViewMode = 'list' | 'card'

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
  viewMode: ViewMode
  selectedItemIds: Set<string>
  exitingItemIds?: Set<string>
  focusedItemId: string | null
  onFile: (id: string) => void
  onPreview: (id: string) => void
  onDelete: (id: string) => void
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
  viewMode,
  selectedItemIds,
  exitingItemIds = new Set(),
  focusedItemId,
  onFile,
  onPreview,
  onDelete,
  onFocus,
  onSelectionToggle,
  onFileAllToUnsorted,
  onReviewOneByOne,
  className
}: StaleSectionProps): React.JSX.Element | null => {
  if (items.length === 0) {
    return null
  }

  const isInBulkMode = selectedItemIds.size > 0

  return (
    <section
      className={cn(
        'rounded-lg border border-amber-500/20 bg-amber-500/5 dark:bg-amber-500/5 mb-6',
        'animate-in fade-in duration-300',
        className
      )}
      aria-labelledby="stale-section-header"
    >
      {/* Section Header */}
      <StaleSectionHeader itemCount={items.length} />

      {/* Items */}
      <div className={cn('p-2', viewMode === 'card' && 'px-3 py-3')}>
        {viewMode === 'list' ? (
          <div className="space-y-0.5">
            {items.map((item) => (
              <StaleItemRow
                key={item.id}
                item={item}
                isFocused={focusedItemId === item.id}
                isSelected={selectedItemIds.has(item.id)}
                isInBulkMode={isInBulkMode}
                isExiting={exitingItemIds.has(item.id)}
                onFile={onFile}
                onPreview={onPreview}
                onDelete={onDelete}
                onFocus={onFocus}
                onSelectionToggle={onSelectionToggle}
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((item) => (
              <StaleCard
                key={item.id}
                item={item}
                isFocused={focusedItemId === item.id}
                isSelected={selectedItemIds.has(item.id)}
                isInBulkMode={isInBulkMode}
                isExiting={exitingItemIds.has(item.id)}
                onFile={onFile}
                onPreview={onPreview}
                onDelete={onDelete}
                onFocus={onFocus}
                onSelectionToggle={onSelectionToggle}
              />
            ))}
          </div>
        )}
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
