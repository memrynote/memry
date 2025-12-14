/**
 * Returning Empty State
 *
 * Shown when user has history but inbox is currently empty
 * and hasn't processed items today. Shows snoozed items preview.
 */
import { useEffect, useState } from 'react'
import { MailOpen, Clock, Plus, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { TypeIcon } from '../type-badge'
import type { InboxItemType } from '@/data/inbox-types'

// =============================================================================
// TYPES
// =============================================================================

export interface SnoozedItemPreview {
  id: string
  type: InboxItemType
  title: string
  returnsAt: Date
}

export interface ReturningEmptyProps {
  snoozedItems?: SnoozedItemPreview[]
  onCapture?: () => void
  onViewSnoozed?: () => void
  className?: string
}

// =============================================================================
// HELPERS
// =============================================================================

function formatReturnTime(date: Date): string {
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffHours = diffMs / (1000 * 60 * 60)
  const diffDays = diffMs / (1000 * 60 * 60 * 24)

  if (diffHours < 1) {
    return 'returns soon'
  } else if (diffHours < 24) {
    const hours = Math.round(diffHours)
    return `returns in ${hours} hour${hours > 1 ? 's' : ''}`
  } else if (diffDays < 2) {
    return 'returns tomorrow'
  } else if (diffDays < 7) {
    const days = Math.round(diffDays)
    return `returns in ${days} days`
  } else {
    return `returns ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
  }
}

// =============================================================================
// SNOOZED ITEM ROW
// =============================================================================

interface SnoozedItemRowProps {
  item: SnoozedItemPreview
  index: number
  isVisible: boolean
}

function SnoozedItemRow({ item, index, isVisible }: SnoozedItemRowProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2.5',
        'transition-all duration-300',
        'hover:bg-accent/50',
        isVisible ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-2'
      )}
      style={{ transitionDelay: `${300 + index * 50}ms` }}
    >
      <TypeIcon type={item.type} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{item.title}</p>
        <p className="text-xs text-muted-foreground/70">
          {formatReturnTime(item.returnsAt)}
        </p>
      </div>
      <Clock className="size-3.5 shrink-0 text-muted-foreground/50" />
    </div>
  )
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ReturningEmpty({
  snoozedItems = [],
  onCapture,
  onViewSnoozed,
  className,
}: ReturningEmptyProps): React.JSX.Element {
  const [isVisible, setIsVisible] = useState(false)

  // Animate in on mount
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 50)
    return () => clearTimeout(timer)
  }, [])

  // Only show first 3 snoozed items
  const displayedItems = snoozedItems.slice(0, 3)
  const remainingCount = Math.max(0, snoozedItems.length - 3)
  const hasSnoozedItems = snoozedItems.length > 0

  return (
    <div
      className={cn(
        'flex min-h-[400px] flex-col items-center justify-center px-6 py-12',
        className
      )}
    >
      {/* Icon */}
      <div
        className={cn(
          'flex size-16 items-center justify-center rounded-2xl',
          'bg-muted/50 border border-border/50',
          'transition-all duration-500',
          isVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-90'
        )}
      >
        <MailOpen className="size-8 text-muted-foreground" />
      </div>

      {/* Headline */}
      <h2
        className={cn(
          'mt-5 text-xl font-semibold tracking-tight text-foreground',
          'transition-all duration-500 delay-100',
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
        )}
      >
        Nothing new in inbox
      </h2>

      {/* Subtext - only show if no snoozed items */}
      {!hasSnoozedItems && (
        <p
          className={cn(
            'mt-2 text-sm text-muted-foreground',
            'transition-all duration-500 delay-150',
            isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
          )}
        >
          Capture something new to get started.
        </p>
      )}

      {/* Snoozed Items Preview */}
      {hasSnoozedItems && (
        <div
          className={cn(
            'mt-6 w-full max-w-sm rounded-xl border border-border/60 bg-card/50',
            'transition-all duration-500 delay-200',
            isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
          )}
        >
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3">
            <Clock className="size-4 text-violet-500" />
            <span className="text-sm font-medium text-foreground">
              Snoozed items returning soon
            </span>
          </div>

          {/* Items */}
          <div className="p-2">
            {displayedItems.map((item, index) => (
              <SnoozedItemRow
                key={item.id}
                item={item}
                index={index}
                isVisible={isVisible}
              />
            ))}
          </div>

          {/* View All / Remaining Count */}
          <div className="border-t border-border/50 px-4 py-2.5">
            <button
              type="button"
              onClick={onViewSnoozed}
              className={cn(
                'flex w-full items-center justify-center gap-1.5',
                'text-sm text-muted-foreground',
                'hover:text-foreground',
                'transition-colors duration-150'
              )}
            >
              {remainingCount > 0 ? (
                <>View all ({snoozedItems.length} snoozed)</>
              ) : (
                <>View snoozed items</>
              )}
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      )}

      {/* CTA */}
      <Button
        variant={hasSnoozedItems ? 'outline' : 'default'}
        onClick={onCapture}
        className={cn(
          'mt-6 gap-2',
          'transition-all duration-500',
          hasSnoozedItems ? 'delay-400' : 'delay-200',
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
        )}
      >
        <Plus className="size-4" />
        Add New Item
      </Button>
    </div>
  )
}
