import { getSetting } from '@main/database/queries/settings'

import { getDatabase, getIndexDatabase } from '../database'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import type { ProjectionEvent, ProjectionProjector } from '../projections/types'
import { getNoteById } from '../vault/notes-crud'
import {
  FoldAgentChoiceSchema,
  FoldChannels,
  type FoldAgentChoice,
  type FoldAgentStatus
} from '@memry/contracts/note-fold'
import { createLogger } from '../lib/logger'
import { getFoldAgentStatus, resolveFoldAgent, resetFoldAgentDetection } from './agent'
import { pruneChunksOlderThan } from './fold-cache'
import { createFoldService, type FoldService } from './fold-service'

const AI_ENABLED_KEY = 'ai.enabled'
const SUMMARIZE_LONG_NOTES_KEY = 'ai.summarizeLongNotes'
const SUMMARIZE_AGENT_KEY = 'ai.summarizeAgent'
const CHUNK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

const logger = createLogger('NoteFold')

/** An unknown stored value (newer build) reads as `auto`. */
function readAgentChoice(): FoldAgentChoice {
  const parsed = FoldAgentChoiceSchema.safeParse(getSetting(getDatabase(), SUMMARIZE_AGENT_KEY))
  return parsed.success ? parsed.data : 'auto'
}

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
    getAgent: () => resolveFoldAgent(readAgentChoice()),
    isEnabled: () => {
      const db = getDatabase()
      return (
        getSetting(db, AI_ENABLED_KEY) !== 'false' &&
        getSetting(db, SUMMARIZE_LONG_NOTES_KEY) === 'true'
      )
    },
    onUpdated: (noteId) => broadcastToAllWindows(FoldChannels.events.UPDATED, { noteId })
  })
  try {
    const removed = pruneChunksOlderThan(getIndexDatabase(), Date.now() - CHUNK_RETENTION_MS)
    logger.debug('Pruned old fold chunks', { removed })
  } catch (error) {
    logger.warn('Pruning fold chunks failed', error)
  }
  return service
}

export function stopNoteFold(): void {
  service?.dispose()
  service = null
}

/** Called when `ai.enabled`, `ai.summarizeLongNotes` or `ai.summarizeAgent` changes: forget the agent probe and refetch open notes. */
export function refreshNoteFold(): void {
  resetFoldAgentDetection()
  service?.refresh()
}

export function getNoteFoldAgentStatus(): Promise<FoldAgentStatus> {
  return getFoldAgentStatus(readAgentChoice())
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
