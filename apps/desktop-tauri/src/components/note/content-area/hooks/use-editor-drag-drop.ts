import { useCallback, useEffect, useState } from 'react'
import { findDropTarget, type DropTarget } from '../drop-target-utils'

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

  // Global event listeners to reset drag state when cancelled or tab loses focus
  useEffect(() => {
    const resetDragState = (): void => {
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
    }
  }, [])

  // Highlight drop target block with subtle background
  useEffect(() => {
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
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setIsDragging(true)
      const target = findDropTarget(e.clientY, containerRef)
      setDropTarget(target)
    },
    [containerRef]
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const { clientX: x, clientY: y } = e
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
      setIsDragging(false)
      setDropTarget(null)
    }
  }, [])

  const handleDrop = useCallback(() => {
    setIsDragging(false)
    setDropTarget(null)
  }, [])

  return { isDragging, dropTarget, handleDragOver, handleDragLeave, handleDrop }
}
