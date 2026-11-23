/**
 * The one owner for a note leaving a file it shares with a case twin (#5297,
 * #5495): a local or remote delete, and a rename or move.
 *
 * On a case-insensitive disk two rows whose paths differ only in case name
 * one file, and the file holds one twin's body. A twin that leaves takes only
 * its row: the file is the other twin's too. Ask `sharesCaseTwinFile` while
 * the leaving row still names the file, then call `keepSurvivorFile` once it
 * no longer does. The file may hold the leaving twin's body, and left as it
 * was, the next vault open would read that body into the survivor and sync it.
 *
 * @module vault/case-twin-file
 */

import { getCrdtProvider } from '../sync/crdt-provider'
import { writebackNow } from '../sync/crdt-writeback'
import { owesFileBody } from '../sync/crdt-owed-file-body'
import { recordBaseline } from '../sync/writeback-baseline'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getIndexDatabase } from '../database'
import { readVaultFile } from '../lib/paths'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { diskCaseOf } from './disk-case'
import { generateContentHash } from './frontmatter'
import { findCanonicalNoteForFile } from './note-sync'

const log = createLogger('CaseTwinFile')

/** Whether a case twin shares this note's file. Ask before the note's row leaves it. */
export function sharesCaseTwinFile(vaultPath: string, relativePath: string): boolean {
  const onDisk = diskCaseOf(vaultPath, relativePath)
  return onDisk !== null && findCanonicalNoteForFile(vaultPath, onDisk)?.sharesFile === true
}

/**
 * - `already-own`: the bytes on disk are, or are now named, the survivor's own.
 * - `written`: the survivor's doc was written over the file.
 * - `no-survivor`: no row names the file any more, or more than one still does.
 * - `refused`: the survivor has no body of its own to write (an empty doc, or
 *   one that owes its file body), or the write did not land. The file is left.
 */
export type SurvivorFileOutcome = 'already-own' | 'written' | 'no-survivor' | 'refused'

/**
 * After twin `leavingId` stopped naming `relativePath`, make the file hold the
 * surviving twin's body: doc to file, never file to doc. The bytes on disk are
 * named the survivor's baseline first, so the write-back writes over them
 * (keeping them as a version) instead of feeding them into the survivor's doc
 * as an outside edit. Never throws: the leave has already happened.
 */
export async function keepSurvivorFile(
  vaultPath: string,
  relativePath: string,
  leavingId: string
): Promise<SurvivorFileOutcome> {
  const onDisk = diskCaseOf(vaultPath, relativePath)
  const survivor = onDisk === null ? null : findCanonicalNoteForFile(vaultPath, onDisk)
  if (!survivor || survivor.sharesFile) return 'no-survivor'
  const context = { leavingId, survivorId: survivor.id, path: survivor.path }
  try {
    const indexDb = getIndexDatabase()
    const raw = await readVaultFile(vaultPath, survivor.path)
    const baseline = getNoteCacheById(indexDb, survivor.id)?.contentHash
    if (raw === null || generateContentHash(raw) === baseline) return 'already-own'

    const provider = getCrdtProvider()
    const live = provider.getDoc(survivor.id)
    const doc = live ?? (await provider.open(survivor.id, undefined, { skipSeed: true }))
    try {
      if (doc.getXmlFragment(CRDT_FRAGMENT_NAME).length === 0 || owesFileBody(survivor.id)) {
        log.warn('The case twin left on a shared file has no body of its own to write', context)
        return 'refused'
      }
      recordBaseline(indexDb, survivor.id, raw)
      await writebackNow(survivor.id, doc)
    } finally {
      if (!live) await provider.closeIfInactive(survivor.id)
    }
    // Unchanged bytes are the doc's serialization, or a pass that could not
    // write; either way they are now the survivor's baseline, so no pass reads
    // them into its doc.
    return (await readVaultFile(vaultPath, survivor.path)) === raw ? 'already-own' : 'written'
  } catch (error) {
    log.error('Could not write the surviving case twin into the shared file', { ...context, error })
    trackMainError('notes', 'case_twin_file_survivor', error)
    return 'refused'
  }
}
