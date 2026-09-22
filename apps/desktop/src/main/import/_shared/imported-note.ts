/**
 * The one note-creation entry point every importer uses.
 *
 * Its only job beyond `createNote` is the checklist step: a `- [ ] …` line an
 * importer produced becomes a real task row before the note is ever written,
 * so the vault file, the note_cache row and the CRDT seed all agree from the
 * first byte, and the note opens as taskBlocks instead of bare checkboxes.
 *
 * Tasks are created through the same domain call the `tasks:create` IPC
 * handler uses, so dirty-tracking, vector clocks, activity log, projections
 * and the task↔note link all happen exactly as they do for a task the user
 * types. Each line is independent: a create that fails leaves that one line as
 * plain markdown and the import continues.
 *
 * @module main/import/_shared/imported-note
 */

import { serializeTaskBlock } from '@memry/shared/task-block'
import { createNote, type Note, type NoteCreateInput } from '../../vault/notes-crud'
import { generateId, generateNoteId } from '../../lib/id'
import { getDatabase, type DataDb } from '../../database'
import { listProjects } from '@main/database/queries/projects'
import { createDesktopTasksDomain } from '../../tasks/domain'
import { createTasksPublisher } from '../../tasks/publisher'
import { getTaskSettings } from '../../settings/task-settings'
import { createLogger } from '../../lib/logger'
import { planChecklistTasks, type PlannedChecklistTask } from './checklist-tasks'

const logger = createLogger('ImportChecklistTasks')

/**
 * Where an imported checklist's tasks land. The note itself has no project at
 * import time, so this is the user's configured default (Settings › Tasks),
 * then the Inbox, then whatever project comes first. `listProjects` leaves out
 * archived projects: a task filed into one is invisible.
 *
 * Null when there is nowhere to file — no databases (an import driven outside
 * an open vault) or a vault with no project at all.
 */
function resolveImportTarget(): { db: DataDb; projectId: string } | null {
  let db: DataDb
  try {
    db = getDatabase()
  } catch {
    return null
  }

  const projects = listProjects(db)
  if (projects.length === 0) return null

  const configuredId = getTaskSettings().defaultProjectId
  const configured = configuredId
    ? projects.find((project) => project.id === configuredId)
    : undefined
  const project = configured ?? projects.find((candidate) => candidate.isInbox) ?? projects[0]
  return { db, projectId: project.id }
}

/**
 * The line an imported task is written back as: the original indentation and
 * list marker (so the import never restructures the note) plus the exact
 * `{task:<id>}` form the editor emits, taken from `serializeTaskBlock` so
 * there is only ever one spelling of that suffix.
 */
function taskLine(item: PlannedChecklistTask, taskId: string, checked: boolean): string {
  const canonical = serializeTaskBlock({ taskId, title: item.title, checked })
  return item.indent + item.listMarker + canonical.slice('-'.length)
}

async function convertChecklistsToTasks(noteId: string, markdown: string): Promise<string> {
  const planned = planChecklistTasks(markdown, new Date())
  if (planned.length === 0) return markdown

  const target = resolveImportTarget()
  if (!target) {
    logger.warn('No project to import checklist tasks into; leaving checkboxes as markdown', {
      noteId,
      checkboxes: planned.length
    })
    return markdown
  }
  const { db, projectId } = target

  const domain = createDesktopTasksDomain(db, createTasksPublisher(), generateId)
  const lines = markdown.split('\n')
  /** Per planned item, the created task id — null when its create failed. */
  const createdIds: (string | null)[] = []

  for (const item of planned) {
    const parentId = item.parentIndex === null ? null : createdIds[item.parentIndex]
    try {
      const result = await domain.createTask({
        projectId,
        ...(parentId ? { parentId } : {}),
        title: item.title,
        priority: item.obsidian?.priority ?? 0,
        dueDate: item.obsidian?.dueDate ?? null,
        startDate: item.obsidian?.startDate ?? null,
        repeatConfig: item.obsidian?.repeatConfig ?? null,
        repeatFrom: item.obsidian?.repeatFrom ?? null,
        description: item.obsidian?.description ?? null,
        tags: item.tags,
        linkedNoteIds: [noteId]
      })
      if (!result.success || !result.task) {
        logger.warn('Checklist task create rejected; leaving the line as markdown', {
          noteId,
          error: result.error
        })
        createdIds.push(null)
        continue
      }

      // Markdown wins: `- [x]` imports as a task that is already done, and the
      // plugin's done date says so too. Left unticked over a task carrying a
      // completedAt, the reconciler would un-complete it on the next note open.
      const completedAt = item.obsidian?.completedAt ?? null
      const checked = item.checked || completedAt !== null
      if (checked) {
        await domain.completeTask({
          id: result.task.id,
          ...(completedAt ? { completedAt } : {})
        })
      }

      lines[item.lineIndex] = taskLine(item, result.task.id, checked)
      createdIds.push(result.task.id)
    } catch (error) {
      // One bad line must not cost the note its import.
      logger.warn('Failed to create a task for an imported checklist line', { noteId, error })
      createdIds.push(null)
    }
  }

  return lines.join('\n')
}

export async function createImportedNote(input: NoteCreateInput): Promise<Note> {
  const id = input.id ?? generateNoteId()
  // The id has to exist before the tasks do: each one links to the note it came
  // from, and `createNote` persists exactly the id it is handed.
  if (!input.content) return createNote({ ...input, id })

  const content = await convertChecklistsToTasks(id, input.content)
  return createNote({ ...input, id, content })
}
