/**
 * Medium Card Component
 *
 * A card component for the medium density view.
 * Shows title, metadata, and type-specific preview content.
 * Height varies by type (80-120px).
 */

import { forwardRef, useState, useCallback } from 'react'
import {
  MoreVertical,
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
import { TypeRenderer } from './type-renderers'
import type { InboxItem } from '@/data/inbox-types'
import { getMetaLine } from '@/lib/inbox-meta-utils'

// ============================================================================
// TYPES
// ============================================================================

export interface MediumCardProps {
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
  /** Callback when card is clicked (with mouse event for modifier keys) */
  onClick?: (id: string, event: React.MouseEvent) => void
  /** Callback when card is double-clicked */
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
// CARD ACTIONS MENU
// ============================================================================

interface CardActionsProps {
  itemId: string
  isVisible: boolean
  onOpenOriginal?: (id: string) => void
  onSnooze?: (id: string) => void
  onDelete?: (id: string) => void
}

function CardActionsMenu({
  itemId,
  isVisible,
  onOpenOriginal,
  onSnooze,
  onDelete,
}: CardActionsProps): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'size-8 rounded-md',
            'text-muted-foreground hover:text-foreground hover:bg-accent',
            'transition-all duration-150',
            isVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical className="size-4" />
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
  isVisible: boolean
  onFile?: (id: string) => void
  onPreview?: (id: string) => void
}

function QuickActions({
  itemId,
  isVisible,
  onFile,
  onPreview,
}: QuickActionsProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-1',
        'transition-opacity duration-150',
        isVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
            onClick={(e) => {
              e.stopPropagation()
              onFile?.(itemId)
            }}
          >
            <FolderInput className="size-4" />
            <span className="sr-only">File</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          <p className="text-xs">File to folder</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
            onClick={(e) => {
              e.stopPropagation()
              onPreview?.(itemId)
            }}
          >
            <Eye className="size-4" />
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
// MEDIUM CARD COMPONENT
// ============================================================================

export const MediumCard = forwardRef<HTMLDivElement, MediumCardProps>(
  function MediumCard(
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
    const showActions = isHovered || isSelected
    const metaLine = getMetaLine(item)

    return (
      <div
        ref={ref}
        role="article"
        tabIndex={0}
        className={cn(
          'group relative rounded-lg border p-4',
          'cursor-pointer select-none',
          'transition-all duration-200 ease-out',
          // Default state
          'bg-card border-border/50',
          // Hover state
          'hover:bg-accent/30 hover:shadow-sm hover:border-border',
          // Selected state
          isSelected && [
            'bg-accent/60 border-l-4 border-l-primary',
            'pl-[14px]', // Compensate for thicker left border
          ],
          // Focused state (keyboard)
          isFocused && [
            'ring-2 ring-primary ring-offset-2 ring-offset-background',
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
        {/* Card Content */}
        <div className="flex gap-3">
          {/* Checkbox Column */}
          <div
            className={cn(
              'flex shrink-0 pt-0.5',
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

          {/* Main Content */}
          <div className="min-w-0 flex-1">
            {/* Header Row: Icon + Title */}
            <div className="flex items-start gap-2.5">
              <div className="shrink-0 pt-0.5">
                <TypeIcon type={item.type} size="md" />
              </div>
              <div className="min-w-0 flex-1">
                <h3
                  className={cn(
                    'text-base font-medium leading-snug',
                    'line-clamp-2',
                    isSelected ? 'text-foreground' : 'text-foreground/90'
                  )}
                >
                  {item.title}
                </h3>
              </div>
            </div>

            {/* Meta Line */}
            <div className="mt-1.5 flex items-center gap-1.5 text-sm text-muted-foreground">
              <span>{metaLine}</span>
            </div>

            {/* Type-Specific Preview Content */}
            <div className="mt-3">
              <TypeRenderer
                item={item}
                onPreviewClick={() => onPreview?.(item.id)}
              />
            </div>
          </div>

          {/* Actions Column */}
          <div className="flex shrink-0 items-start gap-0.5">
            <QuickActions
              itemId={item.id}
              isVisible={showActions}
              onFile={onFile}
              onPreview={onPreview}
            />
            <CardActionsMenu
              itemId={item.id}
              isVisible={showActions}
              onOpenOriginal={onOpenOriginal}
              onSnooze={onSnooze}
              onDelete={onDelete}
            />
          </div>
        </div>
      </div>
    )
  }
)
