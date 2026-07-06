/**
 * Applies the side effects of task-line re-matching (spec 02): external
 * checked toggles and fuzzy title edits go through the tasks domain so events
 * fire and vector clocks bump; orphaned snapshot rows are dropped (the task
 * row itself is never destroyed by a file edit).
 */

import type { TaskCandidate, TaskLineBinding } from '@memry/shared/task-block'
import { requireDatabase } from '../database'
import { deleteNoteTaskLink, getNoteTaskLinks } from '../database/queries/note-task-links'
import { generateId } from '../lib/id'
import { createLogger } from '../lib/logger'
import { createDesktopTasksDomain } from '../tasks/domain'
import { createTasksPublisher } from '../tasks/publisher'

const log = createLogger('TaskLinkEffects')

/** Snapshot rows for a note as re-match candidates, in doc order. */
export function loadTaskLinkCandidates(noteId: string): TaskCandidate[] {
  return getNoteTaskLinks(requireDatabase(), noteId).map((row) => ({
    taskId: row.taskId,
    title: row.title,
    checked: row.checked,
    anchor: row.anchor
  }))
}

export async function applyTaskLinkEffects(
  bindings: TaskLineBinding[],
  orphans: TaskCandidate[]
): Promise<void> {
  if (bindings.length === 0 && orphans.length === 0) return
  const db = requireDatabase()
  const domain = createDesktopTasksDomain(db, createTasksPublisher(), generateId)

  for (const binding of bindings) {
    try {
      const task = domain.getTask(binding.taskId)
      if (!task) continue
      if (binding.rule === 'fuzzy' && task.title !== binding.title) {
        await domain.updateTask({ id: binding.taskId, title: binding.title })
      }
      // Only a genuine external toggle (file differs from the last-serialized
      // snapshot/doc state) may override the task row. A file that merely
      // disagrees with the DB is stale — write-backs run only while the note's
      // doc is open — and must never revert an in-app complete/uncomplete
      // (e.g. from the inline task block or the Tasks page).
      const isDone = Boolean(task.completedAt)
      const externallyToggled =
        binding.candidateChecked !== undefined && binding.checked !== binding.candidateChecked
      if (externallyToggled && binding.checked !== isDone) {
        if (binding.checked) {
          await domain.completeTask({ id: binding.taskId })
        } else {
          await domain.uncompleteTask(binding.taskId)
        }
      }
    } catch (err) {
      log.warn('Failed to apply external task change', { taskId: binding.taskId, err })
    }
  }

  for (const orphan of orphans) {
    try {
      deleteNoteTaskLink(db, orphan.taskId)
    } catch (err) {
      log.warn('Failed to drop orphaned task link', { taskId: orphan.taskId, err })
    }
  }
}
