import { useCallback, useRef } from 'react'

export interface PanelResizeRailProps {
  width: number
  setWidth: React.Dispatch<React.SetStateAction<number>>
  setIsResizing: React.Dispatch<React.SetStateAction<boolean>>
  minPx: number
  maxPx: number
  defaultPx: number
  ariaLabel: string
  title?: string
}

// Matches useResizablePanel's cap: one side panel stays below half the window so
// it can't collide with the day panel (which caps at 0.5).
const VIEWPORT_FRACTION = 0.4

/**
 * Drag rail for a panel docked to the trailing edge. The handle sits on the
 * panel's START (left) edge, so dragging it widens the panel. Double-click resets.
 */
export function PanelResizeRail({
  width,
  setWidth,
  setIsResizing,
  minPx,
  maxPx,
  defaultPx,
  ariaLabel,
  title
}: PanelResizeRailProps): React.JSX.Element {
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      startXRef.current = e.clientX
      startWidthRef.current = width
      setIsResizing(true)

      const onMouseMove = (moveEvent: MouseEvent): void => {
        const delta = moveEvent.clientX - startXRef.current
        const maxWidth = Math.min(maxPx, window.innerWidth * VIEWPORT_FRACTION)
        // Handle is on the START (left) edge: drag left (negative delta) = wider.
        const newWidth = Math.min(maxWidth, Math.max(minPx, startWidthRef.current - delta))
        setWidth(newWidth)
      }

      const onMouseUp = (): void => {
        setIsResizing(false)
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [width, setWidth, setIsResizing, minPx, maxPx]
  )

  const handleDoubleClick = useCallback(() => {
    setWidth(defaultPx)
  }, [setWidth, defaultPx])

  return (
    <button
      aria-label={ariaLabel}
      tabIndex={-1}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      title={title}
      className="absolute inset-y-0 start-0 z-20 w-4 -translate-x-1/2 cursor-col-resize after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] hover:after:bg-sidebar-border"
    />
  )
}

export default PanelResizeRail
