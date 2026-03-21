/**
 * Resize Handle Component
 * Draggable divider for split panes
 */

import { cn } from '@/lib/utils'

interface ResizeHandleProps {
  /** Split direction */
  direction: 'horizontal' | 'vertical'
  /** Whether currently being dragged */
  isResizing: boolean
  /** Callback when resize starts */
  onResizeStart: (e: React.MouseEvent) => void
}

/**
 * Resize handle between split panes
 */
export const ResizeHandle = ({
  direction,
  isResizing,
  onResizeStart
}: ResizeHandleProps): React.JSX.Element => {
  const isHorizontal = direction === 'horizontal'

  return (
    <div
      className={cn(
        // Base styles
        'relative flex-shrink-0 transition-colors',
        'bg-surface-active',
        'hover:bg-tint',

        // Direction-specific styles
        isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',

        // Active state
        isResizing && 'bg-tint',

        // Expand hit area with pseudo-element
        'before:absolute before:inset-0',
        isHorizontal ? 'before:-left-1.5 before:-right-1.5' : 'before:-top-1.5 before:-bottom-1.5'
      )}
      onMouseDown={onResizeStart}
      role="separator"
      aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
      aria-label="Resize panes"
      tabIndex={0}
    >
      {/* Visual grip indicator */}
      <div
        className={cn(
          'absolute inset-0 flex items-center justify-center',
          'opacity-0 hover:opacity-100 transition-opacity'
        )}
      >
        <div
          className={cn('rounded-full bg-text-tertiary', isHorizontal ? 'w-0.5 h-6' : 'w-6 h-0.5')}
        />
      </div>
    </div>
  )
}

export default ResizeHandle
