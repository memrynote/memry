/**
 * One-time, per-vault fill of `note_cache.task_ids`.
 *
 * The column is new, and the indexer skips notes it already knows, so a note
 * indexed before this build would keep a null task order until it is edited
 * again, and Tasks grouped by note would not follow its body. This pass reads
 * each markdown note once and writes the task ids in document order.
 *
 * Runs in the background after the open-time index walk. The marker is written
 * only when the pass finishes, so a close or switch mid-pass resumes on the
 * next open.
 */

import { getAllNoteIds, getNoteCacheById, updateNoteCache } from '@main/database/queries/notes'
import { getSetting, setSetting } from '@main/database/queries/settings'
import { createLogger } from '../lib/logger'
import { readVaultFile } from '../lib/paths'
import { trackMainError } from '../telemetry/diagnostics'
import { scanTaskCheckboxStates } from '@memry/shared/task-block'
import type { DataDb, IndexDb } from '../database'

const logger = createLogger('NoteTaskIdsReindex')

export const NOTE_TASK_IDS_REINDEX_KEY = 'noteTaskIdsReindexV1'
const DONE = 'done'

export interface NoteTaskIdsReindexInput {
  dataDb: DataDb
  getIndexDb: () => IndexDb
  vaultPath: string
  shouldStop: () => boolean
}

/**
 * Number of notes whose task ids were written, or `null` when the pass stopped
 * early or failed. Never throws: a failure leaves the marker unset and the next
 * open retries.
 */
export async function reindexNoteTaskIds(input: NoteTaskIdsReindexInput): Promise<number | null> {
  try {
    if (getSetting(input.dataDb, NOTE_TASK_IDS_REINDEX_KEY) === DONE) return 0
    const written = await writeNoteTaskIds(input)
    if (written === null) return null
    setSetting(input.dataDb, NOTE_TASK_IDS_REINDEX_KEY, DONE)
    logger.info('Indexed note task ids', { written })
    return written
  } catch (error) {
    logger.error('Note task ids reindex failed:', error)
    trackMainError('vault', 'note_task_ids_reindex', error)
    return null
  }
}

async function writeNoteTaskIds(input: NoteTaskIdsReindexInput): Promise<number | null> {
  const { vaultPath, shouldStop } = input
  const indexDb = input.getIndexDb()
  let written = 0
  for (const noteId of getAllNoteIds(indexDb)) {
    if (shouldStop()) return null

    const before = getNoteCacheById(indexDb, noteId)
    if (before?.fileType !== 'markdown' || before.taskIds !== null) continue

    let raw: string | null
    try {
      raw = await readVaultFile(vaultPath, before.path)
      if (raw === null) throw new Error(`Note file is missing: ${before.path}`)
    } catch (error) {
      logger.warn('Skipping note, file unreadable', { noteId, error })
      continue
    }

    // A projection that landed while the file was read already wrote the
    // ids, and it may have read a newer file than this one.
    const after = getNoteCacheById(indexDb, noteId)
    if (!after || after.path !== before.path || after.indexedAt !== before.indexedAt) continue

    // Keeps `indexed_at`: it says when the body was last read, and search
    // reconcile trusts it.
    updateNoteCache(indexDb, noteId, {
      taskIds: [...scanTaskCheckboxStates(raw).keys()],
      indexedAt: after.indexedAt
    })
    written++
  }
  return written
}
