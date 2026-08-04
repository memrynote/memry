/**
 * Markdown is the source of truth for a task's checkbox state.
 *
 * A note body stores its tasks as `- [ ] Title {task:<id>}` lines. When that
 * file is edited outside the app — Obsidian, `sed`, an import that already
 * marked things done — the checkbox is the user's intent, and the `tasks` row
 * must follow it: `[x]` completes the task, `[ ]` reopens it.
 *
 * Only lines whose task id resolves to a real row are touched, and only when
 * the two actually disagree, so re-indexing an unchanged vault is a no-op.
 *
 * @module tasks/reconcile-markdown-tasks
 */

import { scanTaskCheckboxStates } from '@memry/shared/task-block'
import { getTaskById } from '@main/database/queries/tasks'
import { isDatabaseInitialized, getDatabase, type DataDb } from '../database'
import { createDesktopTasksDomain } from './domain'
import { createTasksPublisher } from './publisher'
import { generateId } from '../lib/id'
import { createLogger } from '../lib/logger'

const log = createLogger('ReconcileMarkdownTasks')

export interface ReconcileTaskCheckboxesDeps {
  db: DataDb
  getTask: (db: DataDb, id: string) => { completedAt: string | null } | undefined
  complete: (db: DataDb, id: string) => Promise<unknown>
  uncomplete: (db: DataDb, id: string) => Promise<unknown>
}

function defaultDeps(): ReconcileTaskCheckboxesDeps | null {
  if (!isDatabaseInitialized()) return null
  const domain = (db: DataDb) => createDesktopTasksDomain(db, createTasksPublisher(), generateId)
  return {
    db: getDatabase(),
    getTask: getTaskById,
    complete: (db, id) => domain(db).completeTask({ id }),
    uncomplete: (db, id) => domain(db).uncompleteTask(id)
  }
}

/**
 * Apply a note body's checkbox states to the task rows it references.
 * Returns the number of tasks whose completion state changed.
 */
export async function reconcileTaskCheckboxesFromMarkdown(
  markdown: string,
  deps: ReconcileTaskCheckboxesDeps | null = defaultDeps()
): Promise<number> {
  if (!deps) return 0

  const states = scanTaskCheckboxStates(markdown)
  if (states.size === 0) return 0

  let changed = 0
  for (const [taskId, checked] of states) {
    const task = deps.getTask(deps.db, taskId)
    // Unknown id: the note references a task that was deleted (or belongs to
    // another vault). Nothing to reconcile — the ghost-task UI handles it.
    if (!task) continue
    if (!!task.completedAt === checked) continue

    try {
      if (checked) {
        await deps.complete(deps.db, taskId)
      } else {
        await deps.uncomplete(deps.db, taskId)
      }
      changed++
    } catch (err) {
      log.warn('Failed to reconcile task checkbox from markdown', { taskId, checked, error: err })
    }
  }

  if (changed > 0) log.info('Reconciled task checkboxes from markdown', { changed })
  return changed
}
