/**
 * What happens to a task when its block leaves the note.
 *
 * The editor notices a removal by diffing the task ids in the document before
 * and after a change (`ContentArea.applyTaskIntents`). It used to delete every
 * missing id outright, which was wrong three ways:
 *
 *   - "Move to" appended the line to another note and then removed it here, so
 *     the task was deleted while the target note held its `{task:<id>}` line.
 *   - Cut deleted the task, and pasting the line back brought a dead task id.
 *   - Deleting a block silently deleted a task the user may have wanted to keep.
 *
 * So a removal is now one of four things, decided per id:
 *
 *   - handled: the code that removed the block already dealt with the task (the
 *     task renderer's empty-title teardown deletes it; Move to relinks it).
 *   - undone: undo turned a task this editor converted back into its checkbox.
 *     The task is deleted without asking and the checkbox is made plain
 *     (`ContentArea`, `settleUndoneConversion`).
 *   - moved: cut. The task stays, unlinked from this note.
 *   - asked: anything else. The user chooses between keeping it in Tasks
 *     (unlinked from this note) and deleting it.
 *
 * "Handled" is reported through this module rather than a prop because the task
 * renderer is mounted by BlockNote, not by ContentArea. Keyed by editor, like
 * `marquee-block-registry.ts`.
 */

import { tasksService } from '@/services/tasks-service'

const handledRemovals = new WeakMap<object, Set<string>>()

/** The caller removes these tasks' blocks and deals with the tasks itself. */
export function markTaskRemovalsHandled(editor: object, taskIds: Iterable<string>): void {
  let handled = handledRemovals.get(editor)
  if (!handled) {
    handled = new Set()
    handledRemovals.set(editor, handled)
  }
  for (const taskId of taskIds) if (taskId) handled.add(taskId)
}

/** True (once) when `taskId`'s removal was already dealt with. */
export function takeHandledTaskRemoval(editor: object, taskId: string): boolean {
  return handledRemovals.get(editor)?.delete(taskId) ?? false
}

interface TaskIdBlock {
  type?: string
  props?: { taskId?: unknown }
  children?: TaskIdBlock[]
}

/** Every task id in `blocks` and their descendants. */
export function taskIdsInBlocks(blocks: TaskIdBlock[]): string[] {
  const ids: string[] = []
  const walk = (list: TaskIdBlock[]): void => {
    for (const block of list) {
      const taskId = block.props?.taskId
      if (block.type === 'taskBlock' && typeof taskId === 'string' && taskId) ids.push(taskId)
      if (block.children?.length) walk(block.children)
    }
  }
  walk(blocks)
  return ids
}

/**
 * Rewrite a task's linked notes: drop `unlink`, add `link`. One read and one
 * write, so a move cannot interleave two updates that each overwrite the
 * other's list. A task that is gone, or whose links already say so, is left
 * alone.
 */
export async function relinkTaskNotes(
  taskId: string,
  change: { unlink?: string; link?: string }
): Promise<void> {
  const task = await tasksService.get(taskId)
  if (!task) return
  const current = task.linkedNoteIds ?? []
  const next = current.filter((id) => id !== change.unlink)
  if (change.link && !next.includes(change.link)) next.push(change.link)
  if (next.length === current.length && next.every((id, i) => id === current[i])) return
  await tasksService.update({ id: taskId, linkedNoteIds: next })
}
