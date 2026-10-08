/**
 * Resolves the header flag of tag rows an older build wrote.
 *
 * Builds before index migration 0024 stored a note's header and inline tags in
 * one list, so their rows hold `in_header` NULL, and the indexer skips notes it
 * already knows, so those rows would stay unresolved until each note is edited
 * again. This pass reads the frontmatter at the top of each such file and
 * publishes `note.header-tags-resolved`; the note-derived-state projector writes
 * the flags.
 *
 * Runs in the background after the open-time index walk. There is no settings
 * key: the pending set is the NULL rows, so a pass cut short by a close or a
 * crash resumes on the next open, and an index with none does nothing. It never
 * re-indexes a note or touches `note_metadata`, so no note becomes owed to sync.
 */

import { open, type FileHandle } from 'fs/promises'
import path from 'path'
import { getNoteTags, listNotesWithUnresolvedHeaderTags } from '@main/database/queries/notes'
import { publishProjectionEvent } from '../projections'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { extractTags, parseNote } from './frontmatter'
import type { IndexDb } from '../database'

const logger = createLogger('HeaderTagBackfill')

/** Bytes read from the top of each file. Frontmatter that does not close within them stays unresolved. */
const HEAD_BYTES = 64 * 1024

export interface HeaderTagBackfillInput {
  getIndexDb: () => IndexDb
  vaultPath: string
  shouldStop: () => boolean
}

/**
 * Number of notes whose flags were published, or `null` when the pass stopped
 * early or failed. Never throws: what is left unresolved is retried on the next open.
 */
export async function backfillHeaderTagFlags(
  input: HeaderTagBackfillInput
): Promise<number | null> {
  try {
    const db = input.getIndexDb()
    let resolved = 0
    for (const note of listNotesWithUnresolvedHeaderTags(db)) {
      if (input.shouldStop()) return null
      // A filed binary has no frontmatter: its tags were assigned when it was
      // filed, which makes them header tags.
      const headerTags =
        note.fileType === 'markdown'
          ? await readHeaderTags(path.join(input.vaultPath, note.path))
          : getNoteTags(db, note.id)
      if (headerTags === null) continue
      publishProjectionEvent({ type: 'note.header-tags-resolved', noteId: note.id, headerTags })
      resolved++
    }
    if (resolved > 0)
      logger.info('Resolved the header flags of tags an older build indexed', { resolved })
    return resolved
  } catch (error) {
    logger.error('Header tag backfill failed:', error)
    trackMainError('vault', 'header_tag_backfill', error)
    return null
  }
}

/** The frontmatter `tags:` of a markdown file, or null when the top of the file cannot settle it. */
async function readHeaderTags(absolutePath: string): Promise<string[] | null> {
  let head: string
  let readWholeFile: boolean
  let file: FileHandle | null = null
  try {
    file = await open(absolutePath, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await file.read(buffer, 0, HEAD_BYTES, 0)
    head = buffer.toString('utf8', 0, bytesRead)
    readWholeFile = bytesRead < HEAD_BYTES
  } catch (error) {
    logger.warn('Leaving header flags unresolved: file unreadable', { path: absolutePath, error })
    return null
  } finally {
    await file?.close().catch(() => {})
  }

  const parsed = parseNote(head)
  if (parsed.rawFrontmatterBlock !== null) return extractTags(parsed.frontmatter)
  if (readWholeFile || !head.replace(/^\uFEFF/, '').startsWith('---')) return []
  logger.warn('Leaving header flags unresolved: frontmatter does not close near the top', {
    path: absolutePath
  })
  return null
}
