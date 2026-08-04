/**
 * Propagates a project rename or delete into the frontmatter of every linked
 * markdown note. A note's project membership lives in its frontmatter as a
 * name list, so a rename or delete that only touches the projects table
 * leaves the vault naming a project that no longer matches (or no longer
 * exists) — and a later project created with the old name would silently
 * re-adopt those notes.
 *
 * @module tasks/project-name-propagation
 */

import { PROJECT_PROPERTY_KEY } from '@memry/contracts/property-types'
import { createLogger } from '../lib/logger'
import { getProjectById, listMarkdownNoteIdsForProject } from '../database/queries/projects'
import { getEntityPropertiesRecord, setEntityProperties } from '../notes/entity-properties'
import { readProjectNames, withoutProjectName } from '../notes/project-property'
import type { DataDb } from '../database/types'

const logger = createLogger('ProjectNamePropagation')

/**
 * Reads a project's current name so a caller can detect whether an update
 * actually renamed it. Must be called before the domain update runs, which
 * overwrites the row this reads.
 */
export function captureProjectName(db: DataDb, projectId: string): string | undefined {
  return getProjectById(db, projectId)?.name
}

/**
 * Captures a project's name and the ids of every markdown note linked to it,
 * for a later `propagateProjectDelete` call. Must be called before
 * `deleteProject` runs — its `project_links` FK cascade removes the rows
 * this reads.
 */
export function captureProjectForDelete(
  db: DataDb,
  projectId: string
): { name: string; noteIds: string[] } | undefined {
  const project = getProjectById(db, projectId)
  const noteIds = listMarkdownNoteIdsForProject(db, projectId)
  return project ? { name: project.name, noteIds } : undefined
}

async function rewriteLinkedNotes(
  db: DataDb,
  projectId: string,
  rewrite: (names: string[]) => string[],
  noteIds?: string[]
): Promise<void> {
  const ids = noteIds ?? listMarkdownNoteIdsForProject(db, projectId)

  for (const noteId of ids) {
    const properties = getEntityPropertiesRecord(noteId)
    if (!properties) continue

    const names = readProjectNames(properties)
    const next = rewrite(names)
    if (next.length === names.length && next.every((n, i) => n === names[i])) continue

    try {
      const result = await setEntityProperties(noteId, {
        ...properties,
        [PROJECT_PROPERTY_KEY]: next
      })
      if (!result.success) {
        logger.error('Failed to propagate project name to note', { noteId, error: result.error })
      }
    } catch (err) {
      // One unwritable note must not abandon the rest — a half-propagated rename
      // is recoverable, an abandoned one leaves the vault inconsistent.
      logger.error('Failed to propagate project name to note', { noteId, err })
    }
  }
}

/** Frontmatter stores the name, so a rename must reach every linked note. */
export async function propagateProjectRename(
  db: DataDb,
  projectId: string,
  oldName: string,
  newName: string
): Promise<void> {
  if (oldName === newName) return
  await rewriteLinkedNotes(db, projectId, (names) =>
    names.map((name) => (name.toLowerCase() === oldName.toLowerCase() ? newName : name))
  )
}

/**
 * Frontmatter stores the name, so a delete must remove it from every linked
 * note. `project_links` cascades away with the project, so callers that need
 * the notes affected by the cascade must collect `noteIds` before deleting.
 */
export async function propagateProjectDelete(
  db: DataDb,
  projectId: string,
  name: string,
  noteIds?: string[]
): Promise<void> {
  await rewriteLinkedNotes(db, projectId, (names) => withoutProjectName(names, name), noteIds)
}
