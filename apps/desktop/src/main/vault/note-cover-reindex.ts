/**
 * One-time, per-vault fill of `note_cache.cover`.
 *
 * The column is new, and the indexer skips notes it already knows, so a note
 * that set its cover before this build would show no cover in Gallery view
 * until it is edited again. This pass reads each markdown note's frontmatter
 * once and writes the cover it finds.
 *
 * Runs in the background after the open-time index walk. The marker is written
 * only when the pass finishes, so a close or switch mid-pass resumes on the
 * next open.
 */

import { COVER_FRONTMATTER_KEY, isCoverValue } from '@memry/shared/cover-image'
import { getAllNoteIds, getNoteCacheById, updateNoteCache } from '@main/database/queries/notes'
import { getSetting, setSetting } from '@main/database/queries/settings'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { parseNote } from './frontmatter'
import { readVaultFile } from '../lib/paths'
import type { DataDb, IndexDb } from '../database'

const logger = createLogger('NoteCoverReindex')

export const NOTE_COVER_REINDEX_KEY = 'noteCoverReindexV1'
const DONE = 'done'

export interface NoteCoverReindexInput {
  dataDb: DataDb
  getIndexDb: () => IndexDb
  vaultPath: string
  shouldStop: () => boolean
}

/**
 * Number of notes whose cover was written, or `null` when the pass stopped
 * early or failed. Never throws: a failure leaves the marker unset and the next
 * open retries.
 */
export async function reindexNoteCovers(input: NoteCoverReindexInput): Promise<number | null> {
  try {
    if (getSetting(input.dataDb, NOTE_COVER_REINDEX_KEY) === DONE) return 0
    const written = await writeNoteCovers(input)
    if (written === null) return null
    setSetting(input.dataDb, NOTE_COVER_REINDEX_KEY, DONE)
    logger.info('Indexed note covers', { written })
    return written
  } catch (error) {
    logger.error('Note cover reindex failed:', error)
    trackMainError('vault', 'note_cover_reindex', error)
    return null
  }
}

async function writeNoteCovers(input: NoteCoverReindexInput): Promise<number | null> {
  const { vaultPath, shouldStop } = input
  const indexDb = input.getIndexDb()
  let written = 0
  for (const noteId of getAllNoteIds(indexDb)) {
    if (shouldStop()) return null

    const before = getNoteCacheById(indexDb, noteId)
    if (before?.fileType !== 'markdown' || before.cover !== null) continue

    let raw: string | null
    try {
      raw = await readVaultFile(vaultPath, before.path)
      if (raw === null) throw new Error(`Note file is missing: ${before.path}`)
    } catch (error) {
      logger.warn('Skipping note, file unreadable', { noteId, error })
      continue
    }

    const cover = parseNote(raw, before.path).frontmatter[COVER_FRONTMATTER_KEY]
    if (!isCoverValue(cover)) continue

    // A projection that landed while the file was read already wrote the
    // cover, and it may have read a newer file than this one.
    const after = getNoteCacheById(indexDb, noteId)
    if (!after || after.path !== before.path || after.indexedAt !== before.indexedAt) continue

    // Keeps `indexed_at`: it says when the body was last read, and search
    // reconcile trusts it.
    updateNoteCache(indexDb, noteId, { cover, indexedAt: after.indexedAt })
    written++
  }
  return written
}
