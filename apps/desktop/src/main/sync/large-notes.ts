import fs from 'fs'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { isBinaryFileType } from '@memry/shared/file-types'
import type { FileType } from '@memry/shared/file-types'
import type { LargeNoteEntry, LargeNotesResult } from '@memry/contracts/ipc-sync-ops'
import { getIndexDatabase } from '../database/client'
import { createLogger } from '../lib/logger'
import { toAbsolutePath } from '../vault/notes-io'
import { classifyNoteSyncSize, NOTE_SYNC_MAX_BYTES } from '@memry/sync-client/note-size'

const log = createLogger('LargeNotes')

/**
 * A long list here would be a different problem than the one this answers, so
 * it is capped: the point is "which notes are about to stop syncing", not a
 * full inventory.
 */
const MAX_ENTRIES = 50

export interface LargeNoteRow {
  id: string
  title: string
  path: string
  fileType: FileType | null
  localOnly: boolean | null
}

export function selectLargeNotes(
  rows: LargeNoteRow[],
  measure: (relativePath: string) => number | null
): LargeNoteEntry[] {
  const entries: LargeNoteEntry[] = []

  for (const row of rows) {
    // Attachments ride the blob routes, which the plan's per-file limit
    // governs. This ceiling is only about note bodies.
    if (row.fileType && isBinaryFileType(row.fileType)) continue
    if (row.localOnly) continue

    const sizeBytes = measure(row.path)
    if (sizeBytes === null) continue

    const status = classifyNoteSyncSize(sizeBytes)
    if (status === 'ok') continue

    entries.push({ id: row.id, title: row.title, path: row.path, sizeBytes, status })
  }

  entries.sort((a, b) => b.sizeBytes - a.sizeBytes)
  return entries.slice(0, MAX_ENTRIES)
}

/**
 * Sizes come from `stat` rather than a stored column so an existing vault
 * answers correctly with no reindex and no migration.
 */
export function listLargeNotes(): LargeNotesResult {
  const rows = getIndexDatabase()
    .select({
      id: noteCache.id,
      title: noteCache.title,
      path: noteCache.path,
      fileType: noteCache.fileType,
      localOnly: noteCache.localOnly
    })
    .from(noteCache)
    .all()

  const notes = selectLargeNotes(rows, (relativePath) => {
    try {
      return fs.statSync(toAbsolutePath(relativePath)).size
    } catch {
      // Deleted, moved, or on an unmounted volume — nothing to report.
      return null
    }
  })

  if (notes.length > 0) {
    log.info('Notes at or over the sync ceiling', {
      count: notes.length,
      over: notes.filter((n) => n.status === 'over').length
    })
  }

  return { maxBytes: NOTE_SYNC_MAX_BYTES, notes }
}
