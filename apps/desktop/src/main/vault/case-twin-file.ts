/**
 * Deleting a note whose file a case twin shares (#5297, #5495).
 *
 * On a case-insensitive disk two rows whose paths differ only in case name
 * one file, and the file holds one twin's body. Deleting either twin, here or
 * from a peer's tombstone, drops only its row: the file is the other twin's
 * too. The file may hold the deleted twin's body, so once the row is gone the
 * surviving twin's doc is written into the file, doc to file, never the
 * other way. Left as it was, the next vault open
 * would read the deleted body into the survivor and sync it.
 *
 * @module vault/case-twin-file
 */

import { getCrdtProvider } from '../sync/crdt-provider'
import { writebackNow } from '../sync/crdt-writeback'
import { recordBaseline } from '../sync/writeback-baseline'
import { getIndexDatabase } from '../database'
import { readVaultFile } from '../lib/paths'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { diskCaseOf } from './disk-case'
import { findCanonicalNoteForFile } from './note-sync'

const log = createLogger('CaseTwinFile')

/** Whether a case twin shares the note's file. Ask before the note's row goes. */
export function sharedWithCaseTwin(vaultPath: string, relativePath: string): boolean {
  const onDisk = diskCaseOf(vaultPath, relativePath)
  return onDisk !== null && findCanonicalNoteForFile(vaultPath, onDisk)?.sharesFile === true
}

/**
 * After a twin's row is gone, write the surviving twin's doc into the file the
 * two shared. Nothing is written while more than one row still names the file,
 * or when the survivor has no doc body to give. Never throws: the delete has
 * already happened.
 */
export async function handSharedFileToTwin(
  vaultPath: string,
  relativePath: string,
  deletedId: string
): Promise<void> {
  const onDisk = diskCaseOf(vaultPath, relativePath)
  const survivor = onDisk === null ? null : findCanonicalNoteForFile(vaultPath, onDisk)
  if (!survivor || survivor.sharesFile) return
  try {
    const provider = getCrdtProvider()
    const live = provider.getDoc(survivor.id)
    const doc = live ?? (await provider.open(survivor.id, undefined, { skipSeed: true }))
    if (doc.getXmlFragment(CRDT_FRAGMENT_NAME).length === 0) {
      log.warn('The case twin left with a shared file has no doc body to write', {
        deletedId,
        survivorId: survivor.id
      })
      return
    }
    // The file's bytes may be the deleted twin's body. Named the survivor's
    // baseline, they are written over (and kept as a version) instead of
    // read into the survivor's doc as an outside edit.
    const raw = await readVaultFile(vaultPath, survivor.path)
    if (raw !== null) recordBaseline(getIndexDatabase(), survivor.id, raw)
    await writebackNow(survivor.id, doc)
    if (!live) await provider.closeIfInactive(survivor.id)
  } catch (error) {
    log.error('Could not write the surviving case twin into the shared file', {
      deletedId,
      survivorId: survivor.id,
      error
    })
    trackMainError('notes', 'case_twin_file_handoff', error)
  }
}
