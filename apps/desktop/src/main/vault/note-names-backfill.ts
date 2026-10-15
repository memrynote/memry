/**
 * Builds before index migration 0027 kept no `note_names` rows and no
 * `note_links.target_key`, and the indexer skips notes it already knows, so
 * those notes would answer no wiki-link until each was edited again. Safe to
 * rerun: it only visits notes with no name rows and links with no key.
 */

import path from 'path'
import {
  fillMissingLinkKeys,
  listNotesWithoutNames,
  reindexNoteNames
} from '@main/database/queries/notes'
import { reresolveAndAnnounce } from '../projections/projectors/note-derived-state-projector'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { extractAliases } from './frontmatter'
import { readHeadFrontmatter } from './header-tag-backfill'
import type { IndexDb } from '../database'

const logger = createLogger('NoteNamesBackfill')

export interface NoteNamesBackfillInput {
  getIndexDb: () => IndexDb
  vaultPath: string
  shouldStop: () => boolean
}

export async function backfillNoteNames(input: NoteNamesBackfillInput): Promise<number | null> {
  try {
    const db = input.getIndexDb()
    const keys = new Set<string>(fillMissingLinkKeys(db))
    const notes = listNotesWithoutNames(db)
    for (const note of notes) {
      if (input.shouldStop()) return null
      const frontmatter =
        note.fileType === 'markdown'
          ? await readHeadFrontmatter(path.join(input.vaultPath, note.path))
          : {}
      const aliases = frontmatter ? extractAliases(frontmatter, note.title) : null
      for (const key of reindexNoteNames(db, { noteId: note.id, title: note.title, aliases }))
        keys.add(key)
    }
    if (input.shouldStop()) return null
    reresolveAndAnnounce(db, [...keys])
    if (notes.length > 0) logger.info('Named notes an older build indexed', { named: notes.length })
    return notes.length
  } catch (error) {
    logger.error('Note names backfill failed:', error)
    trackMainError('vault', 'note_names_backfill', error)
    return null
  }
}
