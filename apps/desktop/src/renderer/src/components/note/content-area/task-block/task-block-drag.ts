import { useEffect } from 'react'
import { MEMRY_TASK_DRAG_MIME } from '@/lib/drag-mime'

/**
 * The task id when BlockNote's drag carries exactly one block and it is a task
 * block. `html` is the `blocknote/html` payload, ProseMirror's clipboard
 * serialization, which marks each block with `data-content-type` and writes
 * the task id prop as `data-task-id`.
 */
export function draggedTaskId(html: string): string | null {
  if (!html) return null
  // DOMParser builds an inert document: no scripts or event handlers run.
  const blocks = new DOMParser()
    .parseFromString(html, 'text/html')
    .querySelectorAll('[data-content-type]')
  if (blocks.length !== 1 || blocks[0].getAttribute('data-content-type') !== 'taskBlock')
    return null
  return blocks[0].getAttribute('data-task-id') || null
}

function addTaskDragData(event: DragEvent): void {
  const transfer = event.dataTransfer
  if (!transfer) return
  const taskId = draggedTaskId(transfer.getData('blocknote/html'))
  if (taskId) transfer.setData(MEMRY_TASK_DRAG_MIME, taskId)
}

/**
 * Tags a side-menu drag of a single task block with the task id, so the day
 * panel can schedule it. Listens on the document in the bubble phase, after
 * BlockNote's handle has written (and first cleared) the drag data.
 */
export function useTaskBlockDragData(): void {
  useEffect(() => {
    document.addEventListener('dragstart', addTaskDragData)
    return () => document.removeEventListener('dragstart', addTaskDragData)
  }, [])
}
