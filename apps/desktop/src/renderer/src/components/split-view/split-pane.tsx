/**
 * Split Pane Component
 * Resizable container for two child panes
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { ResizeHandle } from './resize-handle'
import { cn } from '@/lib/utils'

interface SplitPaneProps {
  /** Split direction */
  direction: 'horizontal' | 'vertical'
  /** Current split ratio (0-1) */
  ratio: number
  /** Callback when ratio changes (called during drag for real-time updates) */
  onResize: (ratio: number) => void
  /** Minimum pane size in pixels */
  minSize?: number
  /** Exactly two children */
  children: [React.ReactNode, React.ReactNode]
  /** Additional CSS classes */
  className?: string
}

/**
 * Resizable split pane container
 */
export const SplitPane = ({
  direction,
  ratio,
  onResize,
  minSize = 100,
  children,
  className
}: SplitPaneProps): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isResizing, setIsResizing] = useState(false)
  const [localRatio, setLocalRatio] = useState(ratio)

  // Use ref to track latest ratio for mouseup handler (avoids stale closure)
  const latestRatioRef = useRef(ratio)

  const isHorizontal = direction === 'horizontal'

  // Sync local ratio with prop when not resizing
  useEffect(() => {
    if (!isResizing) {
      setLocalRatio(ratio)
      latestRatioRef.current = ratio
    }
  }, [ratio, isResizing])

  // Handle resize start
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  // Handle resize move and end
  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return

      const rect = containerRef.current.getBoundingClientRect()
      const containerSize = isHorizontal ? rect.width : rect.height
      const position = isHorizontal ? e.clientX - rect.left : e.clientY - rect.top

      // Calculate new ratio with min size constraints
      const minRatio = minSize / containerSize
      const maxRatio = 1 - minRatio
      const newRatio = Math.max(minRatio, Math.min(maxRatio, position / containerSize))

      setLocalRatio(newRatio)
      latestRatioRef.current = newRatio

      // Dispatch ratio change during drag for real-time header sync
      onResize(newRatio)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      // Final update with latest ratio (ensures consistency)
      onResize(latestRatioRef.current)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    // Prevent text selection while dragging
    document.body.style.userSelect = 'none'
    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isResizing, isHorizontal, minSize, onResize])

  // Calculate sizes
  const firstSize = `${localRatio * 100}%`

  return (
    <div
      ref={containerRef}
      data-testid="split-pane"
      data-split-direction={direction}
      className={cn(
        'flex h-full w-full',
        isHorizontal ? 'flex-row' : 'flex-col',
        isResizing && 'select-none',
        className
      )}
    >
      {/* First pane */}
      <div
        className="overflow-hidden"
        style={{
          [isHorizontal ? 'width' : 'height']: firstSize,
          flexShrink: 0
        }}
      >
        {children[0]}
      </div>

      {/* Resize handle */}
      <ResizeHandle
        direction={direction}
        isResizing={isResizing}
        onResizeStart={handleResizeStart}
      />

      {/* Second pane */}
      <div className="flex-1 overflow-hidden min-w-0 min-h-0">{children[1]}</div>
    </div>
  )
}

export default SplitPane
