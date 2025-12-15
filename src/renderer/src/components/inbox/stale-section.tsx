/**
 * Stale Section Component
 *
 * Warning section that highlights inbox items older than 7 days.
 * Encourages users to process old items with batch actions and sequential review.
 */

import { useState, useCallback, useEffect } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FolderInput,
  ListChecks,
  Trash2,
  SkipForward,
  X,
  ArrowRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TypeIcon } from './type-badge'
import type { InboxItem } from '@/data/inbox-types'
import {
  formatStaleAge,
  getStaleAgeCategory,
  getStaleSectionCollapsed,
  setStaleSectionCollapsed,
  type StaleAgeCategory,
} from '@/lib/stale-utils'

// ============================================================================
// TYPES
// ============================================================================

export interface StaleSectionProps {
  /** Stale items to display (pre-filtered, sorted oldest first) */
  items: InboxItem[]
  /** Callback when "File All to Unsorted" is clicked */
  onFileAllToUnsorted?: (items: InboxItem[]) => void
  /** Callback when individual item is filed */
  onFileItem?: (item: InboxItem) => void
  /** Callback when individual item is deleted */
  onDeleteItem?: (item: InboxItem) => void
  /** Callback when an item is clicked/selected for preview */
  onPreviewItem?: (item: InboxItem) => void
  /** Additional class names */
  className?: string
}

// ============================================================================
// AGE INTENSITY STYLES
// ============================================================================

const ageIntensityStyles: Record<StaleAgeCategory, string> = {
  fresh: 'text-muted-foreground',
  aging: 'text-amber-600 dark:text-amber-500',
  stale: 'text-amber-700 dark:text-amber-400 font-medium',
  critical: 'text-orange-600 dark:text-orange-400 font-semibold',
}

// ============================================================================
// STALE ITEM ROW
// ============================================================================

interface StaleItemRowProps {
  item: InboxItem
  isSelected?: boolean
  onSelect?: (id: string, selected: boolean) => void
  onClick?: (item: InboxItem) => void
}

function StaleItemRow({
  item,
  isSelected = false,
  onSelect,
  onClick,
}: StaleItemRowProps): React.JSX.Element {
  const ageCategory = getStaleAgeCategory(item)
  const ageText = formatStaleAge(item.createdAt)

  return (
    <div
      role="row"
      className={cn(
        'group relative flex h-10 items-center gap-3 px-3',
        'cursor-pointer select-none',
        'border-b border-amber-200/50 dark:border-amber-800/30 last:border-b-0',
        'transition-all duration-150',
        'hover:bg-amber-100/60 dark:hover:bg-amber-900/20',
        isSelected && 'bg-amber-100 dark:bg-amber-900/30'
      )}
      onClick={() => onClick?.(item)}
    >
      {/* Checkbox */}
      <div className="flex size-5 shrink-0 items-center justify-center">
        <Checkbox
          checked={isSelected}
          onCheckedChange={(checked) => onSelect?.(item.id, !!checked)}
          onClick={(e) => e.stopPropagation()}
          className="size-4 border-amber-400 data-[state=checked]:bg-amber-600 data-[state=checked]:border-amber-600"
          aria-label={`Select ${item.title}`}
        />
      </div>

      {/* Type Icon */}
      <div className="flex shrink-0 items-center opacity-70">
        <TypeIcon type={item.type} size="sm" />
      </div>

      {/* Title */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-amber-900 dark:text-amber-100">
          {item.title}
        </p>
      </div>

      {/* Age with intensity styling */}
      <div
        className={cn(
          'shrink-0 text-xs tabular-nums',
          ageIntensityStyles[ageCategory]
        )}
      >
        {ageText}
      </div>
    </div>
  )
}

// ============================================================================
// SEQUENTIAL REVIEW DIALOG
// ============================================================================

interface ReviewDialogProps {
  isOpen: boolean
  onClose: () => void
  items: InboxItem[]
  currentIndex: number
  onSkip: () => void
  onDelete: (item: InboxItem) => void
  onFile: (item: InboxItem) => void
  onDone: () => void
}

function ReviewDialog({
  isOpen,
  onClose,
  items,
  currentIndex,
  onSkip,
  onDelete,
  onFile,
  onDone,
}: ReviewDialogProps): React.JSX.Element {
  const currentItem = items[currentIndex]
  const progress = `${currentIndex + 1} of ${items.length}`
  const progressPercent = ((currentIndex + 1) / items.length) * 100

  if (!currentItem) return <></>

  const ageCategory = getStaleAgeCategory(currentItem)
  const ageText = formatStaleAge(currentItem.createdAt)

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg border-amber-200 dark:border-amber-800/50 bg-gradient-to-b from-amber-50/80 to-background dark:from-amber-950/30 dark:to-background">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="text-amber-900 dark:text-amber-100 flex items-center gap-2">
              <ListChecks className="size-5 text-amber-600" />
              Review stale items
            </DialogTitle>
            <span className="text-sm text-amber-700 dark:text-amber-300 tabular-nums">
              {progress}
            </span>
          </div>

          {/* Progress bar */}
          <div className="h-1 w-full rounded-full bg-amber-200 dark:bg-amber-800/50 overflow-hidden mt-2">
            <div
              className="h-full bg-gradient-to-r from-amber-500 to-orange-500 transition-all duration-300 ease-out"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </DialogHeader>

        {/* Item preview */}
        <div className="py-4 space-y-4">
          {/* Item header */}
          <div className="flex items-start gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/40">
              <TypeIcon type={currentItem.type} size="md" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-medium text-foreground truncate">
                {currentItem.title}
              </h3>
              <p className={cn('text-sm', ageIntensityStyles[ageCategory])}>
                Added {ageText}
              </p>
            </div>
          </div>

          {/* Placeholder for full item preview */}
          <div className="rounded-lg border border-amber-200 dark:border-amber-800/40 bg-background p-4 min-h-[120px]">
            <p className="text-sm text-muted-foreground">
              Preview content for this item would appear here...
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between pt-2 border-t border-amber-200/50 dark:border-amber-800/30">
          <Button
            variant="ghost"
            size="sm"
            onClick={onDone}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="mr-1.5 size-4" />
            Done
          </Button>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onSkip}
              className="text-muted-foreground hover:text-foreground"
            >
              <SkipForward className="mr-1.5 size-4" />
              Skip
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => onDelete(currentItem)}
              className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200 dark:border-red-800/50 dark:hover:bg-red-950/30"
            >
              <Trash2 className="mr-1.5 size-4" />
              Delete
            </Button>

            <Button
              size="sm"
              onClick={() => onFile(currentItem)}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              <FolderInput className="mr-1.5 size-4" />
              File
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================================
// STALE SECTION COMPONENT
// ============================================================================

export function StaleSection({
  items,
  onFileAllToUnsorted,
  onFileItem,
  onDeleteItem,
  onPreviewItem,
  className,
}: StaleSectionProps): React.JSX.Element | null {
  // Don't render if no stale items
  if (items.length === 0) {
    return null
  }

  // Collapsed state with persistence
  const [isCollapsed, setIsCollapsed] = useState(() => getStaleSectionCollapsed())

  // Selection state for batch operations
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Review mode state
  const [isReviewOpen, setIsReviewOpen] = useState(false)
  const [reviewIndex, setReviewIndex] = useState(0)

  // Persist collapsed state
  useEffect(() => {
    setStaleSectionCollapsed(isCollapsed)
  }, [isCollapsed])

  // Handlers
  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev)
  }, [])

  const handleSelectItem = useCallback((id: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (selected) {
        next.add(id)
      } else {
        next.delete(id)
      }
      return next
    })
  }, [])

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(items.map((item) => item.id)))
    }
  }, [items, selectedIds.size])

  const handleFileAllToUnsorted = useCallback(() => {
    onFileAllToUnsorted?.(items)
  }, [items, onFileAllToUnsorted])

  const handleStartReview = useCallback(() => {
    setReviewIndex(0)
    setIsReviewOpen(true)
  }, [])

  const handleReviewSkip = useCallback(() => {
    if (reviewIndex < items.length - 1) {
      setReviewIndex((prev) => prev + 1)
    } else {
      setIsReviewOpen(false)
    }
  }, [reviewIndex, items.length])

  const handleReviewDelete = useCallback(
    (item: InboxItem) => {
      onDeleteItem?.(item)
      // Move to next or close if done
      if (reviewIndex < items.length - 1) {
        // Index stays same as the item at that position changes
      } else {
        setIsReviewOpen(false)
      }
    },
    [reviewIndex, items.length, onDeleteItem]
  )

  const handleReviewFile = useCallback(
    (item: InboxItem) => {
      onFileItem?.(item)
      // Move to next or close if done
      if (reviewIndex < items.length - 1) {
        // Index stays same as the item at that position changes
      } else {
        setIsReviewOpen(false)
      }
    },
    [reviewIndex, items.length, onFileItem]
  )

  const handleReviewDone = useCallback(() => {
    setIsReviewOpen(false)
  }, [])

  // Computed values
  const isAllSelected = selectedIds.size === items.length && items.length > 0
  const isPartiallySelected = selectedIds.size > 0 && selectedIds.size < items.length

  return (
    <>
      <section
        className={cn(
          'mx-3 my-4 rounded-xl overflow-hidden',
          'border border-amber-300/70 dark:border-amber-700/50',
          'bg-gradient-to-br from-amber-50/90 via-amber-50/70 to-orange-50/50',
          'dark:from-amber-950/40 dark:via-amber-950/30 dark:to-orange-950/20',
          'shadow-sm shadow-amber-200/50 dark:shadow-amber-900/20',
          className
        )}
        aria-label="Stale items section"
      >
        {/* Header */}
        <button
          type="button"
          onClick={toggleCollapse}
          className={cn(
            'w-full flex items-center gap-3 px-4 py-3',
            'hover:bg-amber-100/50 dark:hover:bg-amber-900/20',
            'transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-inset'
          )}
          aria-expanded={!isCollapsed}
        >
          {/* Collapse indicator */}
          <span className="text-amber-600 dark:text-amber-500">
            {isCollapsed ? (
              <ChevronRight className="size-5" />
            ) : (
              <ChevronDown className="size-5" />
            )}
          </span>

          {/* Warning icon */}
          <div className="flex size-7 items-center justify-center rounded-full bg-amber-200/80 dark:bg-amber-800/50">
            <AlertTriangle className="size-4 text-amber-700 dark:text-amber-400" />
          </div>

          {/* Title */}
          <div className="flex-1 text-left">
            {isCollapsed ? (
              <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
                {items.length} stale {items.length === 1 ? 'item' : 'items'}
              </span>
            ) : (
              <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
                Items older than 7 days ({items.length})
              </span>
            )}
          </div>

          {/* Expand hint when collapsed */}
          {isCollapsed && (
            <span className="text-xs text-amber-600 dark:text-amber-500">
              Expand
            </span>
          )}
        </button>

        {/* Content (when expanded) */}
        {!isCollapsed && (
          <div className="px-4 pb-4">
            {/* Helper text */}
            <p className="text-sm text-amber-700 dark:text-amber-400 mb-3">
              These items have been sitting in your inbox. Consider filing or deleting them.
            </p>

            {/* Items list */}
            <div className="rounded-lg border border-amber-200/70 dark:border-amber-800/40 bg-background overflow-hidden mb-4">
              {/* List header with select all */}
              <div className="flex items-center gap-3 px-3 py-2 border-b border-amber-200/50 dark:border-amber-800/30 bg-amber-50/50 dark:bg-amber-950/20">
                <Checkbox
                  checked={isAllSelected}
                  ref={(el) => {
                    if (el) {
                      // @ts-expect-error - indeterminate is a valid property
                      el.indeterminate = isPartiallySelected
                    }
                  }}
                  onCheckedChange={handleSelectAll}
                  className="size-4 border-amber-400 data-[state=checked]:bg-amber-600 data-[state=checked]:border-amber-600"
                  aria-label="Select all stale items"
                />
                <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
                  {selectedIds.size > 0
                    ? `${selectedIds.size} selected`
                    : 'Select all'}
                </span>
              </div>

              {/* Item rows */}
              <div className="max-h-[220px] overflow-y-auto scrollbar-thin scrollbar-thumb-amber-300 dark:scrollbar-thumb-amber-700">
                {items.map((item) => (
                  <StaleItemRow
                    key={item.id}
                    item={item}
                    isSelected={selectedIds.has(item.id)}
                    onSelect={handleSelectItem}
                    onClick={onPreviewItem}
                  />
                ))}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={handleFileAllToUnsorted}
                className={cn(
                  'border-amber-300 dark:border-amber-700',
                  'text-amber-800 dark:text-amber-200',
                  'hover:bg-amber-100 dark:hover:bg-amber-900/40',
                  'hover:border-amber-400 dark:hover:border-amber-600'
                )}
              >
                <FolderInput className="mr-2 size-4" />
                File All to Unsorted
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={handleStartReview}
                className={cn(
                  'border-amber-300 dark:border-amber-700',
                  'text-amber-800 dark:text-amber-200',
                  'hover:bg-amber-100 dark:hover:bg-amber-900/40',
                  'hover:border-amber-400 dark:hover:border-amber-600'
                )}
              >
                <ArrowRight className="mr-2 size-4" />
                Review One by One
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Sequential review dialog */}
      <ReviewDialog
        isOpen={isReviewOpen}
        onClose={handleReviewDone}
        items={items}
        currentIndex={reviewIndex}
        onSkip={handleReviewSkip}
        onDelete={handleReviewDelete}
        onFile={handleReviewFile}
        onDone={handleReviewDone}
      />
    </>
  )
}
