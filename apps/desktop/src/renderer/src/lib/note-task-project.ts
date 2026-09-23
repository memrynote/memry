/**
 * Which project a task created from inside a note belongs to (#2271).
 *
 * Every note-side creation path used to fall straight from the quick-add
 * `+project` token to "whatever project is flagged inbox", so a task typed in a
 * note that names a project in its frontmatter landed in the inbox anyway, and
 * the Settings > Tasks default project was never consulted. The order below is
 * shared by every path so they cannot drift apart again.
 *
 * @module lib/note-task-project
 */

import { tasksService } from '@/services/tasks-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('NoteTaskProject')

/**
 * The parts of a project this resolution needs, structural because two shapes
 * reach it: the renderer view model (`isDefault`, `isArchived`) from the tasks
 * context, and the IPC shape (`isInbox`, `archivedAt`) from `listProjects`.
 */
export interface ProjectChoice {
  id: string
  isInbox?: boolean
  isDefault?: boolean
  isArchived?: boolean
  archivedAt?: string | null
}

export interface NoteTaskProjectInput {
  /** The parent task's project, for a subtask. Wins over everything else. */
  parentTaskProjectId?: string | null
  /** The project named by a `+project` quick-add token on the line. */
  quickAddProjectId?: string | null
  /** Projects linked to the note, oldest link first (`tasks:listForItem` order). */
  noteProjectIds?: string[]
  /** Settings > Tasks "default project". */
  settingsDefaultProjectId?: string | null
  projects: ProjectChoice[]
}

export interface NoteTaskProjectContext {
  noteProjectIds: string[]
  settingsDefaultProjectId: string | null
}

const isArchivedProject = (project: ProjectChoice): boolean =>
  project.isArchived === true || project.archivedAt != null

/**
 * parent task -> `+project` token -> the note's project -> the Settings > Tasks
 * default -> inbox -> first project. Returns null only when there is no project
 * at all, which callers treat as "do not create".
 *
 * The parent task's and the token's ids are trusted as given: they name a row
 * that already exists, and an archived project is still a legal home for a
 * subtask of a task already living there.
 */
export function resolveNoteTaskProjectId({
  parentTaskProjectId,
  quickAddProjectId,
  noteProjectIds = [],
  settingsDefaultProjectId,
  projects
}: NoteTaskProjectInput): string | null {
  if (parentTaskProjectId) return parentTaskProjectId
  if (quickAddProjectId) return quickAddProjectId

  const byId = new Map(projects.map((project) => [project.id, project]))
  const liveId = (id: string | null | undefined): string | null => {
    if (!id) return null
    const project = byId.get(id)
    return project && !isArchivedProject(project) ? project.id : null
  }

  // A note can link several projects; the first link (oldest by createdAt, id)
  // is what every single-select surface already calls "the" note's project.
  for (const id of noteProjectIds) {
    const live = liveId(id)
    if (live) return live
  }

  const fromSettings = liveId(settingsDefaultProjectId)
  if (fromSettings) return fromSettings

  // `isDefault` is the renderer view model's name for the same "Personal /
  // Inbox" project `isInbox` marks on the IPC shape.
  const inbox = projects.find(
    (project) =>
      (project.isInbox === true || project.isDefault === true) && !isArchivedProject(project)
  )
  if (inbox) return inbox.id

  return projects[0]?.id ?? null
}

/**
 * The note-scoped halves of the chain above. Both are tolerant of failure: a
 * task still has to be creatable when the project links or the settings read
 * fails, it just falls through to the inbox as before.
 */
export async function loadNoteTaskProjectContext(
  noteId: string | null | undefined
): Promise<NoteTaskProjectContext> {
  const [noteProjectIds, settingsDefaultProjectId] = await Promise.all([
    (async () => {
      if (!noteId) return []
      try {
        const linked = await tasksService.listForItem('note', noteId)
        // `listForItem` resolves an error envelope instead of rejecting when
        // the DB read fails, so a raw array is not guaranteed.
        return Array.isArray(linked) ? linked.map((project) => project.id) : []
      } catch (error) {
        log.warn('Failed to read the note project links', error)
        return []
      }
    })(),
    (async () => {
      try {
        const settings = await window.api.settings.getTaskSettings()
        return settings.defaultProjectId
      } catch (error) {
        log.warn('Failed to read the default task project', error)
        return null
      }
    })()
  ])

  return { noteProjectIds, settingsDefaultProjectId }
}

/**
 * The one entry point note-side creation paths call. Skips both IPC reads when
 * a parent task or a `+project` token already decides the answer.
 */
export async function resolveProjectIdForNoteTask(input: {
  noteId?: string | null
  parentTaskProjectId?: string | null
  quickAddProjectId?: string | null
  projects: ProjectChoice[]
}): Promise<string | null> {
  if (input.parentTaskProjectId) return input.parentTaskProjectId
  if (input.quickAddProjectId) return input.quickAddProjectId

  const context = await loadNoteTaskProjectContext(input.noteId)
  return resolveNoteTaskProjectId({ ...input, ...context })
}
