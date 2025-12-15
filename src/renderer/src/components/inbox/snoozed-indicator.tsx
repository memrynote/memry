/**
 * Snoozed Indicator Component
 *
 * Shows a badge/button indicating snoozed items count with a rich popover
 * displaying snoozed items grouped by return time.
 *
 * Aesthetic: Warm amber accents with layered depth and refined typography.
 */

import { useState, useCallback, useMemo } from 'react'
import { Clock, AlarmClock, RotateCcw, ArrowRight, Pause } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TypeIcon } from './type-badge'
import {
  groupSnoozedItems,
  type SnoozedItemWithMeta,
  type SnoozedItemGroup,
} from '@/lib/snooze-utils'
import type { InboxItem } from '@/data/inbox-types'

// ============================================================================
// TYPES
// ============================================================================

export interface SnoozedIndicatorProps {
  /** All inbox items (will filter for snoozed) */
  items: InboxItem[]
  /** Callback when an item is unsnoozed */
  onUnsnooze?: (itemId: string) => void
  /** Callback to preview an item */
  onPreview?: (itemId: string) => void
  /** Callback to view all snoozed items */
  onViewAll?: () => void
  /** Additional class names */
  className?: string
}

// ============================================================================
// SNOOZED ITEM ROW
// ============================================================================

interface SnoozedItemRowProps {
  item: SnoozedItemWithMeta
  onUnsnooze: () => void
  onPreview: () => void
  index: number
}

function SnoozedItemRow({
  item,
  onUnsnooze,
  onPreview,
  index,
}: SnoozedItemRowProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'group flex items-center gap-3 px-2 py-2 rounded-lg',
        'transition-all duration-200',
        'hover:bg-accent/60',
        // Staggered animation
        'animate-in fade-in-0 slide-in-from-left-1',
        'duration-200'
      )}
      style={{
        animationDelay: `${index * 30}ms`,
        animationFillMode: 'backwards',
      }}
    >
      {/* Type Icon with warm tint */}
      <div
        className={cn(
          'flex size-8 items-center justify-center rounded-lg shrink-0',
          'bg-gradient-to-br from-amber-500/8 to-orange-500/5',
          'border border-amber-500/10',
          'transition-all duration-200',
          'group-hover:from-amber-500/12 group-hover:to-orange-500/8'
        )}
      >
        <TypeIcon type={item.type} size="sm" />
      </div>

      {/* Content */}
      <button
        type="button"
        onClick={onPreview}
        className={cn(
          'flex-1 flex flex-col items-start min-w-0 text-left',
          'focus:outline-none'
        )}
      >
        <span
          className={cn(
            'text-sm font-medium text-foreground/90 truncate w-full',
            'group-hover:text-foreground transition-colors'
          )}
        >
          {item.title}
        </span>
        <span className="text-xs text-muted-foreground/70 flex items-center gap-1">
          <Clock className="size-3" />
          {item.formattedReturnTime}
        </span>
      </button>

      {/* Unsnooze Button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => {
          e.stopPropagation()
          onUnsnooze()
        }}
        className={cn(
          'h-7 px-2 opacity-0 group-hover:opacity-100',
          'text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400',
          'hover:bg-amber-500/10',
          'transition-all duration-150'
        )}
      >
        <RotateCcw className="size-3.5 mr-1" />
        <span className="text-xs">Now</span>
      </Button>
    </div>
  )
}

// ============================================================================
// SNOOZED GROUP
// ============================================================================

interface SnoozedGroupProps {
  group: SnoozedItemGroup
  onUnsnooze: (itemId: string) => void
  onPreview: (itemId: string) => void
  startIndex: number
}

function SnoozedGroup({
  group,
  onUnsnooze,
  onPreview,
  startIndex,
}: SnoozedGroupProps): React.JSX.Element {
  return (
    <div className="mb-4 last:mb-0">
      {/* Group Label */}
      <div className="flex items-center gap-2 px-2 mb-1.5">
        <span className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-wider">
          {group.label}
        </span>
        <div className="flex-1 h-px bg-gradient-to-r from-border/50 to-transparent" />
      </div>

      {/* Items */}
      <div className="space-y-0.5">
        {group.items.map((item, idx) => (
          <SnoozedItemRow
            key={item.id}
            item={item}
            onUnsnooze={() => onUnsnooze(item.id)}
            onPreview={() => onPreview(item.id)}
            index={startIndex + idx}
          />
        ))}
      </div>
    </div>
  )
}

// ============================================================================
// EMPTY STATE
// ============================================================================

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-8 px-4">
      <div
        className={cn(
          'flex size-12 items-center justify-center rounded-2xl mb-3',
          'bg-gradient-to-br from-amber-500/10 to-orange-500/5',
          'border border-amber-500/10'
        )}
      >
        <Pause className="size-5 text-amber-500/60" />
      </div>
      <p className="text-sm font-medium text-foreground/70 mb-1">
        No snoozed items
      </p>
      <p className="text-xs text-muted-foreground/60 text-center max-w-[200px]">
        Snoozed items will appear here until they return to your inbox
      </p>
    </div>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function SnoozedIndicator({
  items,
  onUnsnooze,
  onPreview,
  onViewAll,
  className,
}: SnoozedIndicatorProps): React.JSX.Element | null {
  const [isOpen, setIsOpen] = useState(false)

  // Group snoozed items
  const groups = useMemo(() => groupSnoozedItems(items), [items])
  const totalSnoozed = useMemo(
    () => groups.reduce((sum, g) => sum + g.items.length, 0),
    [groups]
  )

  const handleUnsnooze = useCallback(
    (itemId: string) => {
      onUnsnooze?.(itemId)
    },
    [onUnsnooze]
  )

  const handlePreview = useCallback(
    (itemId: string) => {
      onPreview?.(itemId)
      setIsOpen(false)
    },
    [onPreview]
  )

  // Don't render if no snoozed items
  if (totalSnoozed === 0) {
    return null
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'group inline-flex items-center gap-1.5 px-2 py-1 rounded-md',
            'text-sm text-muted-foreground/80',
            'transition-all duration-200',
            // Hover state with warm glow
            'hover:text-amber-600 dark:hover:text-amber-400',
            'hover:bg-amber-500/8',
            // Active/open state
            isOpen && [
              'text-amber-600 dark:text-amber-400',
              'bg-amber-500/10',
            ],
            className
          )}
        >
          <AlarmClock
            className={cn(
              'size-3.5 transition-transform duration-200',
              'group-hover:scale-105',
              isOpen && 'scale-105'
            )}
          />
          <span className="font-medium tabular-nums">{totalSnoozed}</span>
          <span className="hidden sm:inline">snoozed</span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={8}
        className={cn(
          'w-80 p-0 overflow-hidden',
          // Warm gradient border effect
          'border-amber-500/10',
          // Subtle shadow with amber tint
          'shadow-lg shadow-amber-500/5',
          'bg-gradient-to-b from-background to-background/95'
        )}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border/50">
          <div className="flex items-center gap-2.5">
            <div
              className={cn(
                'flex size-8 items-center justify-center rounded-xl',
                'bg-gradient-to-br from-amber-500/15 to-orange-500/10',
                'border border-amber-500/20',
                'shadow-sm shadow-amber-500/10'
              )}
            >
              <AlarmClock className="size-4 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Snoozed Items
              </h3>
              <p className="text-xs text-muted-foreground">
                {totalSnoozed} item{totalSnoozed !== 1 ? 's' : ''} waiting to
                return
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <ScrollArea className="max-h-[320px]">
          <div className="p-3">
            {groups.length === 0 ? (
              <EmptyState />
            ) : (
              groups.map((group, groupIndex) => {
                // Calculate starting index for animations
                const startIndex = groups
                  .slice(0, groupIndex)
                  .reduce((sum, g) => sum + g.items.length, 0)

                return (
                  <SnoozedGroup
                    key={group.label}
                    group={group}
                    onUnsnooze={handleUnsnooze}
                    onPreview={handlePreview}
                    startIndex={startIndex}
                  />
                )
              })
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        {groups.length > 0 && onViewAll && (
          <div className="px-3 py-2 border-t border-border/50 bg-accent/30">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onViewAll()
                setIsOpen(false)
              }}
              className={cn(
                'w-full justify-center gap-2',
                'text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400',
                'hover:bg-amber-500/10'
              )}
            >
              View all snoozed
              <ArrowRight className="size-3.5" />
            </Button>
          </div>
        )}

        {/* Bottom accent bar */}
        <div
          className={cn(
            'h-0.5',
            'bg-gradient-to-r from-amber-500/40 via-orange-500/30 to-amber-500/40'
          )}
        />
      </PopoverContent>
    </Popover>
  )
}

// ============================================================================
// COMPACT BADGE VARIANT
// ============================================================================

export interface SnoozedBadgeProps {
  count: number
  onClick?: () => void
  className?: string
}

export function SnoozedBadge({
  count,
  onClick,
  className,
}: SnoozedBadgeProps): React.JSX.Element | null {
  if (count === 0) return null

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full',
        'text-xs font-medium',
        'bg-amber-500/10 text-amber-700 dark:text-amber-400',
        'border border-amber-500/20',
        'hover:bg-amber-500/15 hover:border-amber-500/30',
        'transition-all duration-150',
        className
      )}
    >
      <AlarmClock className="size-3" />
      {count} snoozed
    </button>
  )
}

// ============================================================================
// RETURNING ITEM HIGHLIGHT
// ============================================================================

export interface ReturningItemHighlightProps {
  item: InboxItem
  onDismiss?: () => void
  className?: string
}

export function ReturningItemHighlight({
  item,
  onDismiss,
  className,
}: ReturningItemHighlightProps): React.JSX.Element {
  // Calculate how long ago it was snoozed
  const snoozedAgo = useMemo(() => {
    if (!item.snoozedAt) return ''
    const diffMs = Date.now() - item.snoozedAt.getTime()
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    const hours = Math.floor(diffMs / (1000 * 60 * 60))

    if (days > 0) {
      return `Snoozed ${days} day${days !== 1 ? 's' : ''} ago`
    }
    return `Snoozed ${hours} hour${hours !== 1 ? 's' : ''} ago`
  }, [item.snoozedAt])

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3 rounded-lg',
        // Warm highlight background with animated gradient
        'bg-gradient-to-r from-amber-500/10 via-orange-500/5 to-amber-500/10',
        'border-l-4 border-amber-500',
        // Subtle animation on mount
        'animate-in fade-in-0 slide-in-from-top-2 duration-300',
        className
      )}
    >
      {/* Bell icon */}
      <div
        className={cn(
          'flex size-9 items-center justify-center rounded-xl shrink-0',
          'bg-amber-500/20',
          'border border-amber-500/30'
        )}
      >
        <AlarmClock className="size-4 text-amber-600" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">
          Snoozed item returned
        </p>
        <p className="text-xs text-muted-foreground truncate">{snoozedAgo}</p>
      </div>

      {/* Dismiss */}
      {onDismiss && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          className="h-7 px-2 text-muted-foreground hover:text-foreground"
        >
          <span className="text-xs">Dismiss</span>
        </Button>
      )}
    </div>
  )
}
