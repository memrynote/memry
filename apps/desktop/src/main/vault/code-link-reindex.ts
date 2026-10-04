/**
 * One-time, per-vault refresh of the link rows of notes that write `[[…]]`
 * inside code (AF-006).
 *
 * Builds before this one read link syntax in inline code and fenced code
 * blocks as real links, and the indexer skips notes it already knows, so those
 * rows (unresolved graph nodes, wrong backlinks) would stay until each note is
 * edited again. Only a note that already has a link row can carry one, so only
 * those are read.
 *
 * Runs in the background after the open-time index walk. The marker is written
 * only when the pass finishes, so a close or switch mid-pass resumes on the
 * next open.
 */

import { readFile } from 'fs/promises'
import path from 'path'
import { blankMarkdownCode } from '@memry/shared/markdown-code'
import {
  getNoteCacheById,
  listLinkSourceIds,
  resolveNotesByTitles,
  setNoteLinks
} from '@main/database/queries/notes'
import { getSetting, setSetting } from '@main/database/queries/settings'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { extractWikiLinks, parseNote } from './frontmatter'
import type { DataDb, IndexDb } from '../database'

const logger = createLogger('CodeLinkReindex')

export const CODE_LINK_REINDEX_KEY = 'codeLinkReindexV1'
const DONE = 'done'

export interface CodeLinkReindexInput {
  dataDb: DataDb
  getIndexDb: () => IndexDb
  vaultPath: string
  shouldStop: () => boolean
}

/**
 * Number of notes whose link rows were rewritten, or `null` when the pass
 * stopped early or failed. Never throws: a failure leaves the marker unset and
 * the next open retries.
 */
export async function reindexCodeLinks(input: CodeLinkReindexInput): Promise<number | null> {
  try {
    if (getSetting(input.dataDb, CODE_LINK_REINDEX_KEY) === DONE) return 0
    const rewritten = await rewriteCodeLinks(input)
    if (rewritten === null) return null
    setSetting(input.dataDb, CODE_LINK_REINDEX_KEY, DONE)
    if (rewritten > 0)
      logger.info('Refreshed links of notes with link syntax in code', { rewritten })
    return rewritten
  } catch (error) {
    logger.error('Code link reindex failed:', error)
    trackMainError('vault', 'code_link_reindex', error)
    return null
  }
}

async function rewriteCodeLinks(input: CodeLinkReindexInput): Promise<number | null> {
  const { vaultPath, shouldStop } = input
  const indexDb = input.getIndexDb()
  let rewritten = 0
  for (const noteId of listLinkSourceIds(indexDb)) {
    if (shouldStop()) return null

    const before = getNoteCacheById(indexDb, noteId)
    if (!before) continue

    let raw: string
    try {
      raw = await readFile(path.join(vaultPath, before.path), 'utf-8')
    } catch (error) {
      logger.warn('Skipping note, file unreadable', { noteId, error })
      continue
    }

    const body = parseNote(raw, before.path).content
    if (body.split('[[').length === blankMarkdownCode(body).split('[[').length) continue

    // A projection that landed while the file was read already used the new
    // extractor, and it may have read a newer body than this one.
    const after = getNoteCacheById(indexDb, noteId)
    if (!after || after.path !== before.path || after.indexedAt !== before.indexedAt) continue

    const titles = extractWikiLinks(body)
    const resolved = resolveNotesByTitles(indexDb, titles)
    setNoteLinks(
      indexDb,
      noteId,
      titles.map((title) => ({ targetTitle: title, targetId: resolved.get(title)?.id }))
    )
    rewritten++
  }
  return rewritten
}
