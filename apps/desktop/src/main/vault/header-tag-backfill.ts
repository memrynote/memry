/**
 * Builds before index migration 0024 stored a note's header and inline tags in
 * one list, so their rows hold `in_header` NULL, and the indexer skips notes it
 * already knows, so those rows would stay unresolved until each note is edited
 * again.
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

const HEAD_BYTES = 64 * 1024

export interface HeaderTagBackfillInput {
  getIndexDb: () => IndexDb
  vaultPath: string
  shouldStop: () => boolean
}

export async function backfillHeaderTagFlags(
  input: HeaderTagBackfillInput
): Promise<number | null> {
  try {
    const db = input.getIndexDb()
    let resolved = 0
    for (const note of listNotesWithUnresolvedHeaderTags(db)) {
      if (input.shouldStop()) return null
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
