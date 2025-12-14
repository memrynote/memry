/**
 * Medium View Component
 *
 * The default view for the inbox, showing cards with rich previews.
 * Balances information density with meaningful content previews.
 */

import { useCallback } from 'react'
import { cn } from '@/lib/utils'
import { MediumCard } from './medium-card'
import type { InboxItem } from '@/data/inbox-types'

// ============================================================================
// TYPES
// ============================================================================

export interface MediumViewProps {
  /** Items to display */
  items: InboxItem[]
  /** Currently selected item IDs */
  selectedIds: Set<string>
  /** Currently focused item ID (keyboard navigation) */
  focusedId?: string | null
  /** Whether bulk mode is active */
  isBulkMode?: boolean
  /** Callback when selection changes */
  onSelectionChange?: (selectedIds: Set<string>) => void
  /** Callback when an item is clicked */
  onItemClick?: (id: string) => void
  /** Callback when an item is double-clicked */
  onItemDoubleClick?: (id: string) => void
  /** Callback when file action is triggered */
  onFile?: (ids: string[]) => void
  /** Callback when preview is triggered */
  onPreview?: (id: string) => void
  /** Callback when open original is triggered */
  onOpenOriginal?: (id: string) => void
  /** Callback when snooze is triggered */
  onSnooze?: (ids: string[]) => void
  /** Callback when delete is triggered */
  onDelete?: (ids: string[]) => void
  /** Additional class names */
  className?: string
}

// ============================================================================
// MEDIUM VIEW COMPONENT
// ============================================================================

export function MediumView({
  items,
  selectedIds,
  focusedId,
  isBulkMode = false,
  onSelectionChange,
  onItemClick,
  onItemDoubleClick,
  onFile,
  onPreview,
  onOpenOriginal,
  onSnooze,
  onDelete,
  className,
}: MediumViewProps): React.JSX.Element {
  // Handle individual item selection change
  const handleSelectionChange = useCallback(
    (id: string, selected: boolean) => {
      const newSelectedIds = new Set(selectedIds)
      if (selected) {
        newSelectedIds.add(id)
      } else {
        newSelectedIds.delete(id)
      }
      onSelectionChange?.(newSelectedIds)
    },
    [selectedIds, onSelectionChange]
  )

  // Handle item click
  const handleItemClick = useCallback(
    (id: string) => {
      onItemClick?.(id)
    },
    [onItemClick]
  )

  // Handle item double-click
  const handleItemDoubleClick = useCallback(
    (id: string) => {
      onItemDoubleClick?.(id)
    },
    [onItemDoubleClick]
  )

  // Handle file action
  const handleFile = useCallback(
    (id: string) => {
      // If item is selected and there are multiple selections, file all selected
      if (selectedIds.has(id) && selectedIds.size > 1) {
        onFile?.(Array.from(selectedIds))
      } else {
        onFile?.([id])
      }
    },
    [selectedIds, onFile]
  )

  // Handle preview action
  const handlePreview = useCallback(
    (id: string) => {
      onPreview?.(id)
    },
    [onPreview]
  )

  // Handle open original action
  const handleOpenOriginal = useCallback(
    (id: string) => {
      onOpenOriginal?.(id)
    },
    [onOpenOriginal]
  )

  // Handle snooze action
  const handleSnooze = useCallback(
    (id: string) => {
      // If item is selected and there are multiple selections, snooze all selected
      if (selectedIds.has(id) && selectedIds.size > 1) {
        onSnooze?.(Array.from(selectedIds))
      } else {
        onSnooze?.([id])
      }
    },
    [selectedIds, onSnooze]
  )

  // Handle delete action
  const handleDelete = useCallback(
    (id: string) => {
      // If item is selected and there are multiple selections, delete all selected
      if (selectedIds.has(id) && selectedIds.size > 1) {
        onDelete?.(Array.from(selectedIds))
      } else {
        onDelete?.([id])
      }
    },
    [selectedIds, onDelete]
  )

  // Empty state
  if (items.length === 0) {
    return (
      <div
        className={cn(
          'flex h-64 items-center justify-center text-muted-foreground',
          className
        )}
      >
        <p className="text-sm">No items to display</p>
      </div>
    )
  }

  return (
    <div
      role="feed"
      aria-label="Inbox items"
      className={cn(
        'flex flex-col gap-3 px-6 py-4',
        className
      )}
    >
      {items.map((item) => (
        <MediumCard
          key={item.id}
          item={item}
          isSelected={selectedIds.has(item.id)}
          isFocused={focusedId === item.id}
          isBulkMode={isBulkMode}
          onSelectionChange={handleSelectionChange}
          onClick={handleItemClick}
          onDoubleClick={handleItemDoubleClick}
          onFile={handleFile}
          onPreview={handlePreview}
          onOpenOriginal={handleOpenOriginal}
          onSnooze={handleSnooze}
          onDelete={handleDelete}
        />
      ))}
    </div>
  )
}
