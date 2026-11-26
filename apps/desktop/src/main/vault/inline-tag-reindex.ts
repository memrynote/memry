/**
 * One-time, per-vault re-index of the notes whose body names an inline `#tag`
 * their tag rows lack (#5716).
 *
 * Builds before this one read an inline tag in ASCII letters only, so `#퓨리`,
 * `#привет` and `#2024년` stayed prose, and the indexer skips notes it already
 * knows: those tags would stay out of the tag list, and an opened note would
 * not show them as chips, until each note is edited again. This pass reads
 * each markdown note once and hands the ones missing a tag back to the
 * indexer, which reads them as a fresh build does.
 *
 * Runs in the background after the open-time index walk. The marker is written
 * only when the pass finishes, so a close or switch mid-pass resumes on the
 * next open.
 */

import { extractInlineTagsFromMarkdown } from '@memry/shared/inline-tags'
import { foldTag } from '@memry/shared/tag-fold'
import { getAllNoteIds, getNoteCacheById, getNoteTags } from '@main/database/queries/notes'
import { getSetting, setSetting } from '@main/database/queries/settings'
import { createLogger } from '../lib/logger'
import { readVaultFile } from '../lib/paths'
import { trackMainError } from '../telemetry/diagnostics'
import { parseNote } from './frontmatter'
import { indexVault } from './indexer'
import type { DataDb, IndexDb } from '../database'

const logger = createLogger('InlineTagReindex')

export const INLINE_TAG_REINDEX_KEY = 'inlineTagReindexV1'
const DONE = 'done'

export interface InlineTagReindexInput {
  dataDb: DataDb
  getIndexDb: () => IndexDb
  vaultPath: string
  shouldStop: () => boolean
}

/**
 * Number of notes re-indexed, or `null` when the pass stopped early or failed.
 * Never throws: a failure leaves the marker unset and the next open retries.
 */
export async function reindexInlineTags(input: InlineTagReindexInput): Promise<number | null> {
  try {
    if (getSetting(input.dataDb, INLINE_TAG_REINDEX_KEY) === DONE) return 0
    const stale = await notesMissingInlineTags(input)
    if (stale === null) return null
    if (stale.length > 0) {
      const result = await indexVault(input.vaultPath, {
        shouldStop: input.shouldStop,
        forcePaths: stale
      })
      if (result.cancelled || result.errors > 0) return null
    }
    setSetting(input.dataDb, INLINE_TAG_REINDEX_KEY, DONE)
    logger.info('Re-indexed notes with inline tags an older build did not read', {
      reindexed: stale.length
    })
    return stale.length
  } catch (error) {
    logger.error('Inline tag reindex failed:', error)
    trackMainError('vault', 'inline_tag_reindex', error)
    return null
  }
}

async function notesMissingInlineTags(input: InlineTagReindexInput): Promise<string[] | null> {
  const { vaultPath, shouldStop } = input
  const indexDb = input.getIndexDb()
  const stale: string[] = []
  for (const noteId of getAllNoteIds(indexDb)) {
    if (shouldStop()) return null

    const note = getNoteCacheById(indexDb, noteId)
    if (note?.fileType !== 'markdown') continue

    let raw: string | null
    try {
      raw = await readVaultFile(vaultPath, note.path)
      if (raw === null) throw new Error(`Note file is missing: ${note.path}`)
    } catch (error) {
      logger.warn('Skipping note, file unreadable', { noteId, error })
      continue
    }

    const indexed = new Set(getNoteTags(indexDb, noteId).map(foldTag))
    const inline = extractInlineTagsFromMarkdown(parseNote(raw, note.path).content)
    if (inline.some((tag) => !indexed.has(foldTag(tag)))) stale.push(note.path)
  }
  return stale
}
