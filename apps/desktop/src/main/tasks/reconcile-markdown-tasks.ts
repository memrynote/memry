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
 * A disagreement alone is not intent. Nothing rewrites a note when its task is
 * completed somewhere else (the Tasks view, a synced peer, the CLI), so a note
 * can say `[ ]` for a done task for as long as nobody opens it. Following such
 * a line reopened the task, and sync spread the reopen to every device. So a
 * line follows the file only when it was edited: its checkbox differs from the
 * state the app last acknowledged for the note (`note_cache.task_checks`), or,
 * for a line the app has no state for, the file is newer than the task row.
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
import { trackMainError } from '../telemetry/diagnostics'

const log = createLogger('ReconcileMarkdownTasks')

export interface ReconcileTaskCheckboxesDeps {
  db: DataDb
  getTask: (
    db: DataDb,
    id: string
  ) => { completedAt: string | null; modifiedAt: string } | undefined
  complete: (db: DataDb, id: string) => Promise<unknown>
  uncomplete: (db: DataDb, id: string) => Promise<unknown>
}

const domain = (db: DataDb) => createDesktopTasksDomain(db, createTasksPublisher(), generateId)

function defaultDeps(): ReconcileTaskCheckboxesDeps | null {
  if (!isDatabaseInitialized()) return null
  return {
    db: getDatabase(),
    getTask: getTaskById,
    complete: (db, id) => domain(db).completeTask({ id }),
    uncomplete: (db, id) => domain(db).uncompleteTask(id)
  }
}

export interface TaskCheckboxSource {
  markdown: string
  /** Checkbox states of the bytes the app last acknowledged for the note; null when it has none. */
  acknowledged: Record<string, boolean> | null
  /** The file's mtime, which decides a line the app has no acknowledged state for. */
  fileModifiedAt: Date
}

/**
 * Apply a note body's edited checkbox states to the task rows it references.
 * Returns the number of tasks whose completion state changed.
 */
export async function reconcileTaskCheckboxesFromMarkdown(
  source: TaskCheckboxSource,
  deps: ReconcileTaskCheckboxesDeps | null = defaultDeps()
): Promise<number> {
  if (!deps) return 0

  const states = scanTaskCheckboxStates(source.markdown)
  if (states.size === 0) return 0

  let changed = 0
  for (const [taskId, checked] of states) {
    const task = deps.getTask(deps.db, taskId)
    // Unknown id: the note references a task that was deleted (or belongs to
    // another vault). Nothing to reconcile — the ghost-task UI handles it.
    if (!task) continue
    if (!!task.completedAt === checked) continue

    const edited =
      source.acknowledged !== null && Object.hasOwn(source.acknowledged, taskId)
        ? source.acknowledged[taskId] !== checked
        : source.fileModifiedAt.getTime() > Date.parse(task.modifiedAt)
    if (!edited) continue

    try {
      if (checked) {
        await deps.complete(deps.db, taskId)
      } else {
        await deps.uncomplete(deps.db, taskId)
      }
      changed++
    } catch (err) {
      log.warn('Failed to reconcile task checkbox from markdown', { taskId, checked, error: err })
      // Markdown (source of truth) and the tasks row stay divergent here.
      trackMainError('tasks', 'reconcile_checkbox', err)
    }
  }

  if (changed > 0) log.info('Reconciled task checkboxes from markdown', { changed })
  return changed
}
