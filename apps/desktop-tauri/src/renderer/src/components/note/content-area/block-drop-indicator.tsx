/**
 * BlockDropIndicator Component
 *
 * Displays a visual indicator showing where a dragged file will be inserted
 * between blocks in the editor. Uses the same styling as the task insertion
 * indicator for consistency.
 */

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { calculateIndicatorPosition, type DropTarget } from './drop-target-utils'

// =============================================================================
// TYPES
// =============================================================================

interface BlockDropIndicatorProps {
  /** The drop target information */
  dropTarget: DropTarget
  /** Reference to the editor container for position calculations */
  containerRef: React.RefObject<HTMLElement | null>
  /** Additional class names */
  className?: string
}

// =============================================================================
// BLOCK DROP INDICATOR COMPONENT
// =============================================================================

/**
 * A visual indicator showing where a dragged file will be inserted between blocks.
 * Displays as a horizontal line with a circle at the start, positioned relative
 * to the target block element.
 */
export function BlockDropIndicator({
  dropTarget,
  containerRef,
  className
}: BlockDropIndicatorProps): React.JSX.Element | null {
  // Calculate position during render (not in effect) to avoid cascading renders
  const indicatorStyle = useMemo(() => {
    return calculateIndicatorPosition(dropTarget, containerRef)
  }, [dropTarget, containerRef])

  // Don't render if position cannot be calculated
  if (!indicatorStyle) return null

  return (
    <div
      className={cn(
        'absolute h-0.5 bg-primary pointer-events-none z-30',
        'transition-[top] duration-75 ease-out',
        className
      )}
      style={indicatorStyle}
      aria-hidden="true"
    >
      {/* Circle at the start of the line */}
      <div className="absolute -left-1 w-2 h-2 bg-primary rounded-full -top-[3px]" />
    </div>
  )
}

// =============================================================================
// EMPTY DOCUMENT DROP INDICATOR
// =============================================================================

interface EmptyDocumentDropIndicatorProps {
  /** Additional class names */
  className?: string
}

/**
 * A simple horizontal line indicator for empty documents.
 * Shown at the top of the editor when there are no blocks.
 */
export function EmptyDocumentDropIndicator({
  className
}: EmptyDocumentDropIndicatorProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'absolute top-4 left-0 right-0 h-0.5 bg-primary pointer-events-none z-30',
        className
      )}
      aria-hidden="true"
    >
      {/* Circle at the start of the line */}
      <div className="absolute -left-1 w-2 h-2 bg-primary rounded-full -top-[3px]" />
    </div>
  )
}

export default BlockDropIndicator
