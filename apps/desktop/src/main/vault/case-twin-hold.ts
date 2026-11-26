/**
 * Whether a binary note's file is held instead of pushed because it may hold
 * a case twin's bytes (#5522, #5560): a file twins share, or one marked in
 * `case-twin-bytes.ts`. Apart from the marks because it reads the rows on a
 * file through `note-sync.ts`, which clears a deleted note's mark.
 *
 * @module vault/case-twin-hold
 */

import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { createLogger } from '../lib/logger'
import { getDatabase } from '../database'
import { holdsCaseTwinForeignBytes, recordHeldCaseTwinChange } from './case-twin-bytes'
import { diskCaseOf } from './disk-case'
import { findCanonicalNoteForFile } from './note-sync'

const log = createLogger('CaseTwinHold')

/**
 * Whether the watcher holds an outside change to binary note `noteId`'s file
 * instead of pushing it, logging the hold. Every watcher path that would push
 * the file asks. A file a case twin shares holds one twin's bytes, whichever
 * row the event names (#5522); the change is recorded for the split
 * (`planBinarySurvivor`). After a split, a file that may hold the other twin's
 * bytes is held until the note's own download lands (#5560), which keeps a
 * change since the mark as a conflict copy.
 */
export function holdsBinaryChange(
  vaultPath: string,
  relativePath: string,
  noteId: string
): boolean {
  return holdsBinaryFile(getDatabase(), vaultPath, relativePath, noteId, true)
}

/**
 * `holdsBinaryChange` for an upload no change event asked for (the attachment
 * backfill): the file is held, and nothing is recorded as changed.
 */
export function holdsBinaryUpload(
  db: DrizzleDb,
  vaultPath: string,
  relativePath: string,
  noteId: string
): boolean {
  return holdsBinaryFile(db, vaultPath, relativePath, noteId, false)
}

function holdsBinaryFile(
  db: DrizzleDb,
  vaultPath: string,
  relativePath: string,
  noteId: string,
  changed: boolean
): boolean {
  const onDisk = diskCaseOf(vaultPath, relativePath)
  const shared = onDisk !== null && findCanonicalNoteForFile(vaultPath, onDisk)?.sharesFile === true
  if (shared && changed) recordHeldCaseTwinChange(db, onDisk)
  if (!shared && !holdsCaseTwinForeignBytes(db, noteId)) return false
  log.warn("A file that may hold a case twin's bytes is not pushed", {
    noteId,
    path: relativePath,
    reason: shared ? 'shared' : 'foreign'
  })
  return true
}
