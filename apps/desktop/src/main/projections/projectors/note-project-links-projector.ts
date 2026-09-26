import { randomUUID } from 'crypto'
import { createLogger } from '../../lib/logger'
import { trackMainError } from '../../telemetry/diagnostics'
import { getDatabase, type DataDb } from '../../database'
import {
  deleteProjectLink,
  insertProjectLink,
  listNoteProjectLinkIds,
  listProjectsByNames
} from '../../database/queries/projects'
import { readProjectNames } from '../../notes/project-property'
import { commitLocalChange } from '../../sync/sync-intents'
import type { ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:NoteProjectLinks')

/**
 * Derives a markdown note's `project_links` rows from its frontmatter, which is
 * the source of truth. Rows that survive the diff are never deleted and
 * reinserted — that is what preserves `position` and `pinned`, which are
 * project-hub state that has nothing to do with the note.
 *
 * Exported because the sync update path writes a note's properties without
 * publishing `note.upserted` (see `sync/item-handlers/note-handler.ts`), so it
 * has to drive this directly. Callers outside the projector must guard on the
 * note actually being markdown, and must not let a throw here fail their own
 * work.
 */
export function reconcileNoteLinks(noteId: string, properties: Record<string, unknown>): void {
  const db = getDatabase()

  const names = readProjectNames(properties)
  const resolved = listProjectsByNames(db, names)

  // `listProjectsByNames` is ordered oldest-first, so the first write per lowered
  // name wins and later duplicates are the ambiguous ones.
  const byName = new Map<string, string>()
  for (const project of resolved) {
    const key = project.name.toLowerCase()
    if (byName.has(key)) {
      logger.warn('Ambiguous project name, resolving to the oldest', { name: project.name })
      continue
    }
    byName.set(key, project.id)
  }

  const desired = new Set<string>()
  for (const name of names) {
    const projectId = byName.get(name.toLowerCase())
    if (!projectId) {
      logger.debug('Project name matches no project, leaving it unlinked', { noteId, name })
      continue
    }
    desired.add(projectId)
  }

  // A project's links only sync because its own payload carries them, and a
  // link write does not move `projects.modified_at`, so no sweep would find a
  // lost one: the link rows and the project's sync intent commit together (#2301).
  commitLocalChange(db, () => {
    const touched = writeNoteLinks(db, noteId, desired)
    return {
      value: undefined,
      intents: [...touched].map((projectId) => ({
        type: 'project' as const,
        itemId: projectId,
        op: 'update' as const,
        args: [['links']]
      }))
    }
  })
}

function writeNoteLinks(db: DataDb, noteId: string, desired: ReadonlySet<string>): Set<string> {
  const existing = listNoteProjectLinkIds(db, noteId)
  const existingProjectIds = new Set(existing.map((row) => row.projectId))
  const touched = new Set<string>()

  for (const projectId of desired) {
    if (existingProjectIds.has(projectId)) continue
    insertProjectLink(db, {
      id: randomUUID(),
      projectId,
      itemType: 'note',
      itemId: noteId
    })
    touched.add(projectId)
  }

  for (const row of existing) {
    if (desired.has(row.projectId)) continue
    // Delete under the row's own `item_type`, not a hardcoded 'note': a link
    // written by the project-hub file importer carries 'file' even for a
    // markdown note, and would otherwise be undeletable.
    deleteProjectLink(db, row.projectId, row.itemType, noteId)
    touched.add(row.projectId)
  }
  return touched
}

export function createNoteProjectLinksProjector(): ProjectionProjector {
  return {
    name: 'note-project-links',

    handles(event: ProjectionEvent): boolean {
      return event.type === 'note.upserted'
    },

    async project(event: ProjectionEvent): Promise<void> {
      if (event.type !== 'note.upserted') return
      if (event.note.kind !== 'markdown') return

      try {
        reconcileNoteLinks(event.note.noteId, event.note.properties)
      } catch (err) {
        // A reconcile failure must not stall the projection queue behind it.
        // Frontmatter is the source of truth for note→project membership, so a
        // recurring failure means project_links drift stale — surface it in
        // Error Tracking, not just a log line.
        logger.error('Failed to reconcile project links', err)
        trackMainError('tasks', 'note_project_links_reconcile', err)
      }
    },

    async rebuild(): Promise<void> {
      // This projector keeps no state beyond what project() derives per
      // note.upserted event, so there is nothing to rebuild independently of
      // that stream — same staleness class as the rest of the note-derived
      // pipeline for a frontmatter edit made while the app is closed (indexVault
      // skips already-cached paths and the watcher ignores its initial scan).
    },

    async reconcile(): Promise<void> {
      // See rebuild(): no independent state to check against note.upserted.
    }
  }
}
