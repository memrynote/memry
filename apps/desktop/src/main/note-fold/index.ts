import { getSetting } from '@main/database/queries/settings'

import { getDatabase, getIndexDatabase } from '../database'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import type { ProjectionEvent, ProjectionProjector } from '../projections/types'
import { getNoteById } from '../vault/notes-crud'
import { FoldChannels } from '@memry/contracts/note-fold'
import { resolveFoldAgent, resetFoldAgentDetection } from './agent'
import { createFoldService, type FoldService } from './fold-service'

const AI_ENABLED_KEY = 'ai.enabled'
const SUMMARIZE_LONG_NOTES_KEY = 'ai.summarizeLongNotes'

let service: FoldService | null = null

/** Called per vault open; the service is bound to that vault's index DB. */
export function startNoteFold(): FoldService {
  service?.dispose()
  resetFoldAgentDetection()
  service = createFoldService({
    getDb: getIndexDatabase,
    getSource: async (noteId) => {
      const note = await getNoteById(noteId)
      if (!note) return null
      return note.contentOmitted ? '' : note.content
    },
    getAgent: resolveFoldAgent,
    isEnabled: () => {
      const db = getDatabase()
      return (
        getSetting(db, AI_ENABLED_KEY) !== 'false' &&
        getSetting(db, SUMMARIZE_LONG_NOTES_KEY) === 'true'
      )
    },
    onUpdated: (noteId) => broadcastToAllWindows(FoldChannels.events.UPDATED, { noteId })
  })
  return service
}

export function stopNoteFold(): void {
  service?.dispose()
  service = null
}

export function getNoteFold(): FoldService {
  if (!service) throw new Error('No vault is open')
  return service
}

/**
 * Edits reach the fold service through the projection bus. Only notes the
 * renderer has opened regenerate, so an import or a vault re-index triggers nothing.
 */
export function createNoteFoldProjector(): ProjectionProjector {
  return {
    name: 'note-fold',
    background: true,
    handles: (event: ProjectionEvent) =>
      event.type === 'note.upserted' && event.note.kind === 'markdown',
    project(event: ProjectionEvent) {
      if (event.type === 'note.upserted') service?.noteChanged(event.note.noteId)
    },
    rebuild: () => undefined,
    reconcile: () => undefined
  }
}
