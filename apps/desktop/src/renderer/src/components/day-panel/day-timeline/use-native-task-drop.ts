import { useEffect, useEffectEvent, useState, type RefObject } from 'react'
import { MEMRY_TASK_DRAG_MIME } from '@/lib/drag-mime'

export interface DragPoint {
  x: number
  y: number
}

function carriesTask(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(MEMRY_TASK_DRAG_MIME) ?? false
}

function isInside(target: RefObject<HTMLElement | null>, event: DragEvent): boolean {
  return event.target instanceof Node && (target.current?.contains(event.target) ?? false)
}

/**
 * Makes `target` accept a task dragged out of a note (an HTML5 drag carrying
 * MEMRY_TASK_DRAG_MIME). Listens on the window in the capture phase and stops
 * the events it accepts there: BlockNote's document-level listeners would
 * otherwise redirect a drop within 250px of an editor into that editor and
 * move the block. `onMove` sees every dragover of a task drag, wherever the
 * pointer is, so the caller can track it.
 */
export function useNativeTaskDrop(
  target: RefObject<HTMLElement | null>,
  handlers: {
    onDrop: (taskId: string, point: DragPoint) => void
    onMove?: (point: DragPoint) => void
    onEnd?: () => void
  }
): { isOver: boolean } {
  const [isOver, setIsOver] = useState(false)
  const onDrop = useEffectEvent(handlers.onDrop)
  const onMove = useEffectEvent((point: DragPoint) => handlers.onMove?.(point))
  const onEnd = useEffectEvent(() => handlers.onEnd?.())

  useEffect(() => {
    const end = (): void => {
      setIsOver(false)
      onEnd()
    }
    const handleOver = (event: DragEvent): void => {
      if (!carriesTask(event)) return
      onMove({ x: event.clientX, y: event.clientY })
      const inside = isInside(target, event)
      setIsOver(inside)
      if (!inside) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    }
    const handleDrop = (event: DragEvent): void => {
      if (!carriesTask(event)) return
      if (isInside(target, event)) {
        event.preventDefault()
        event.stopPropagation()
        const taskId = event.dataTransfer?.getData(MEMRY_TASK_DRAG_MIME)
        if (taskId) onDrop(taskId, { x: event.clientX, y: event.clientY })
      }
      end()
    }
    window.addEventListener('dragover', handleOver, true)
    window.addEventListener('drop', handleDrop, true)
    window.addEventListener('dragend', end, true)
    return () => {
      window.removeEventListener('dragover', handleOver, true)
      window.removeEventListener('drop', handleDrop, true)
      window.removeEventListener('dragend', end, true)
    }
  }, [target])

  return { isOver }
}
