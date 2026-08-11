import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { findDropTarget, type DropTarget } from '../drop-target-utils'
import { MEMRY_NOTE_DRAG_MIME } from '@/lib/drag-mime'

function isSameDropTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.blockId === b.blockId && a.position === b.position
}

interface EditorDragDropParams {
  containerRef: React.RefObject<HTMLDivElement | null>
}

interface EditorDragDropResult {
  isDragging: boolean
  dropTarget: DropTarget | null
  handleDragOver: (e: React.DragEvent) => void
  handleDragLeave: (e: React.DragEvent) => void
  handleDrop: () => void
}

export function useEditorDragDrop({ containerRef }: EditorDragDropParams): EditorDragDropResult {
  const [isDragging, setIsDragging] = useState(false)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)

  // `dragover` fires continuously while the cursor hovers, and resolving the drop
  // target walks the block list reading `getBoundingClientRect` on each one. Park
  // the latest pointer Y here and resolve it at most once per frame instead.
  const pendingClientYRef = useRef(0)
  const measureFrameRef = useRef<number | null>(null)

  const cancelPendingMeasure = useCallback((): void => {
    if (measureFrameRef.current === null) return
    cancelAnimationFrame(measureFrameRef.current)
    measureFrameRef.current = null
  }, [])

  // Measures live rects every frame rather than caching them for the drag: the
  // note can scroll, reflow or settle an image mid-drag, and a stale rect would
  // land the drop somewhere the indicator never pointed at.
  const measureDropTarget = useCallback((): void => {
    measureFrameRef.current = null
    const next = findDropTarget(pendingClientYRef.current, containerRef)
    // Keep the previous object when the target is unchanged so React bails out
    // instead of re-rendering the editor and repositioning the indicator.
    setDropTarget((prev) => (isSameDropTarget(prev, next) ? prev : next))
  }, [containerRef])

  // Global event listeners to reset drag state when cancelled or tab loses focus
  useEffect(() => {
    const resetDragState = (): void => {
      cancelPendingMeasure()
      setIsDragging(false)
      setDropTarget(null)
    }

    window.addEventListener('dragend', resetDragState)

    const handleVisibilityChange = (): void => {
      if (document.hidden) {
        resetDragState()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('blur', resetDragState)

    return () => {
      window.removeEventListener('dragend', resetDragState)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('blur', resetDragState)
      cancelPendingMeasure()
    }
  }, [cancelPendingMeasure])

  // Highlight drop target block with subtle background. useLayoutEffect avoids
  // running after paint and removes a no-pass-live-state-to-parent false positive.
  useLayoutEffect(() => {
    if (!dropTarget || !containerRef.current) return

    const blockElement = containerRef.current.querySelector(`[data-id="${dropTarget.blockId}"]`)
    if (!blockElement) return

    blockElement.classList.add('bg-primary/5', 'transition-colors', 'duration-150')

    return () => {
      blockElement.classList.remove('bg-primary/5', 'transition-colors', 'duration-150')
    }
  }, [dropTarget, containerRef])

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.stopPropagation()
      const types = e.dataTransfer.types
      const isFileDrag = types.includes('Files')
      const isInternalItem = types.includes(MEMRY_NOTE_DRAG_MIME)
      // Both an OS file drop and a file-type sidebar item can be embedded.
      if (!isFileDrag && !isInternalItem) return
      e.preventDefault()
      if (isInternalItem && !isFileDrag) e.dataTransfer.dropEffect = 'copy'
      setIsDragging(true)
      // preventDefault above runs on every event — only the measuring is throttled,
      // otherwise the browser would reject the drop.
      pendingClientYRef.current = e.clientY
      if (measureFrameRef.current === null) {
        measureFrameRef.current = requestAnimationFrame(measureDropTarget)
      }
    },
    [measureDropTarget]
  )

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = e.currentTarget.getBoundingClientRect()
      const { clientX: x, clientY: y } = e
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
        cancelPendingMeasure()
        setIsDragging(false)
        setDropTarget(null)
      }
    },
    [cancelPendingMeasure]
  )

  // Drops consume the committed target — the one the indicator is showing — so a
  // frame still in flight is dropped rather than flushed.
  const handleDrop = useCallback(() => {
    cancelPendingMeasure()
    setIsDragging(false)
    setDropTarget(null)
  }, [cancelPendingMeasure])

  return { isDragging, dropTarget, handleDragOver, handleDragLeave, handleDrop }
}
