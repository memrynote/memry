/**
 * Compact Row Component
 *
 * A dense 44px row for the compact list view.
 * Optimized for power users processing many items quickly.
 */

import { forwardRef, useState, useCallback } from 'react'
import {
  MoreHorizontal,
  FolderInput,
  Eye,
  ExternalLink,
  Clock,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { TypeIcon } from './type-badge'
import type { InboxItem } from '@/data/inbox-types'
import { formatRelativeTime } from '@/lib/inbox-utils'

// ============================================================================
// TYPES
// ============================================================================

export interface CompactRowProps {
  /** The inbox item to display */
  item: InboxItem
  /** Whether the item is selected */
  isSelected?: boolean
  /** Whether the item is focused (keyboard navigation) */
  isFocused?: boolean
  /** Whether bulk mode is active (always show checkbox) */
  isBulkMode?: boolean
  /** Callback when selection changes */
  onSelectionChange?: (id: string, selected: boolean) => void
  /** Callback when row is clicked (with mouse event for modifier keys) */
  onClick?: (id: string, event: React.MouseEvent) => void
  /** Callback when row is double-clicked */
  onDoubleClick?: (id: string) => void
  /** Callback when file action is triggered */
  onFile?: (id: string) => void
  /** Callback when preview action is triggered */
  onPreview?: (id: string) => void
  /** Callback when open original is triggered */
  onOpenOriginal?: (id: string) => void
  /** Callback when snooze is triggered */
  onSnooze?: (id: string) => void
  /** Callback when delete is triggered */
  onDelete?: (id: string) => void
  /** Additional class names */
  className?: string
}

// ============================================================================
// ROW ACTIONS MENU
// ============================================================================

interface RowActionsProps {
  itemId: string
  onOpenOriginal?: (id: string) => void
  onSnooze?: (id: string) => void
  onDelete?: (id: string) => void
}

function RowActionsMenu({
  itemId,
  onOpenOriginal,
  onSnooze,
  onDelete,
}: RowActionsProps): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'size-7 rounded-md',
            'text-muted-foreground hover:text-foreground',
            'opacity-0 group-hover:opacity-100',
            'transition-opacity duration-100',
            'focus-visible:opacity-100'
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="size-4" />
          <span className="sr-only">More actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation()
            onOpenOriginal?.(itemId)
          }}
        >
          <ExternalLink className="mr-2 size-4" />
          Open Original
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation()
            onSnooze?.(itemId)
          }}
        >
          <Clock className="mr-2 size-4" />
          Snooze
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation()
            onDelete?.(itemId)
          }}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 size-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ============================================================================
// QUICK ACTIONS
// ============================================================================

interface QuickActionsProps {
  itemId: string
  onFile?: (id: string) => void
  onPreview?: (id: string) => void
}

function QuickActions({
  itemId,
  onFile,
  onPreview,
}: QuickActionsProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-0.5',
        'opacity-0 group-hover:opacity-100',
        'transition-opacity duration-100'
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-md text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              onFile?.(itemId)
            }}
          >
            <FolderInput className="size-3.5" />
            <span className="sr-only">File</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          <p className="text-xs">File</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-md text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              onPreview?.(itemId)
            }}
          >
            <Eye className="size-3.5" />
            <span className="sr-only">Preview</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          <p className="text-xs">Preview</p>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

// ============================================================================
// COMPACT ROW COMPONENT
// ============================================================================

export const CompactRow = forwardRef<HTMLDivElement, CompactRowProps>(
  function CompactRow(
    {
      item,
      isSelected = false,
      isFocused = false,
      isBulkMode = false,
      onSelectionChange,
      onClick,
      onDoubleClick,
      onFile,
      onPreview,
      onOpenOriginal,
      onSnooze,
      onDelete,
      className,
    },
    ref
  ) {
    const [isHovered, setIsHovered] = useState(false)

    const handleClick = useCallback(
      (e: React.MouseEvent) => {
        // Always pass the click event with modifier info
        // The parent component decides how to handle selection
        onClick?.(item.id, e)
      },
      [item.id, onClick]
    )

    const handleDoubleClick = useCallback(() => {
      onDoubleClick?.(item.id)
    }, [item.id, onDoubleClick])

    const handleCheckboxChange = useCallback(
      (checked: boolean) => {
        onSelectionChange?.(item.id, checked)
      },
      [item.id, onSelectionChange]
    )

    const showCheckbox = isHovered || isBulkMode || isSelected

    return (
      <div
        ref={ref}
        role="row"
        tabIndex={0}
        className={cn(
          'group relative flex h-11 items-center gap-3 px-3',
          'cursor-pointer select-none',
          'border-b border-border/40',
          'transition-all duration-150 ease-out',
          // Default state
          'bg-transparent',
          // Hover state
          'hover:bg-accent/50',
          // Selected state
          isSelected && [
            'bg-accent',
            'border-l-2 border-l-primary',
            'pl-[10px]', // Compensate for border
          ],
          // Focused state (keyboard)
          isFocused && [
            'ring-2 ring-primary ring-offset-1 ring-offset-background',
            'z-10',
          ],
          className
        )}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        aria-selected={isSelected}
      >
        {/* Checkbox */}
        <div
          className={cn(
            'flex size-5 shrink-0 items-center justify-center',
            'transition-opacity duration-100',
            showCheckbox ? 'opacity-100' : 'opacity-0'
          )}
        >
          <Checkbox
            checked={isSelected}
            onCheckedChange={handleCheckboxChange}
            onClick={(e) => e.stopPropagation()}
            className="size-4"
            aria-label={`Select ${item.title}`}
          />
        </div>

        {/* Type Icon */}
        <div className="flex shrink-0 items-center">
          <TypeIcon type={item.type} size="sm" />
        </div>

        {/* Title */}
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'truncate text-sm font-medium',
              isSelected ? 'text-foreground' : 'text-foreground/90'
            )}
          >
            {item.title}
          </p>
        </div>

        {/* Timestamp - hidden when hovering to make room for actions */}
        <div
          className={cn(
            'shrink-0 text-xs text-muted-foreground',
            'transition-opacity duration-100',
            isHovered ? 'opacity-0 w-0' : 'opacity-100'
          )}
        >
          {formatRelativeTime(item.createdAt)}
        </div>

        {/* Quick Actions - visible on hover */}
        <QuickActions
          itemId={item.id}
          onFile={onFile}
          onPreview={onPreview}
        />

        {/* Actions Menu */}
        <RowActionsMenu
          itemId={item.id}
          onOpenOriginal={onOpenOriginal}
          onSnooze={onSnooze}
          onDelete={onDelete}
        />
      </div>
    )
  }
)
