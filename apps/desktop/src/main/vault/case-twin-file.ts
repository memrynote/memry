/**
 * The one owner for a note leaving a file it shares with a case twin (#5297,
 * #5495): a local or remote delete, and a rename or move.
 *
 * On a case-insensitive disk two rows whose paths differ only in case name
 * one file, and the file holds one twin's body. A twin that leaves takes only
 * its row: the file is the other twin's too. The bytes on disk may be the
 * leaving twin's body, and the survivor must never read them in.
 *
 * 1. `sharesCaseTwinFile`, while the leaving row still names the file.
 * 2. `claimSharedFile`, in the same synchronous step as the leaving row's
 *    drop, with no await between. Bytes that are not the survivor's own are
 *    named its baseline, so from then on no pass reads them into its doc as an
 *    outside edit: a write-back writes the doc over them. An owed file body
 *    (`crdt-owed-file-body.ts`) is cleared with them: the bytes it owed are
 *    gone, and a take would read the leaving twin's body. A crash after this
 *    step leaves bytes only a doc-to-file pass touches.
 * 3. `keepSurvivorFile`, after the step: writes the survivor's doc over the
 *    claimed bytes. A survivor with an empty doc has no body here to write,
 *    and its next open would seed the doc from the file, so the claimed bytes
 *    are kept as one of its versions and the file is emptied; its body comes
 *    with its next server merge.
 *
 * @module vault/case-twin-file
 */

import { getCrdtProvider } from '../sync/crdt-provider'
import { markWritebackIgnored, writebackNow } from '../sync/crdt-writeback'
import { clearOwedFileBody, owesFileBody } from '../sync/crdt-owed-file-body'
import { recordBaseline, writeWithBaseline } from '../sync/writeback-baseline'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { SnapshotReasons } from '@memry/db-schema/schema/notes-cache'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getIndexDatabase } from '../database'
import { readVaultFileSync } from '../lib/paths'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { diskCaseOf } from './disk-case'
import { atomicWrite } from './file-ops'
import { generateContentHash } from './frontmatter'
import { findCanonicalNoteForFile } from './note-sync'
import { toAbsolutePath } from './notes-io'
import { createSnapshot } from './notes-versions'

const log = createLogger('CaseTwinFile')

/** The twin left on a shared file, and the bytes there that are not its own. */
export interface SurvivorClaim {
  leavingId: string
  survivorId: string
  survivorPath: string
  title: string
  /** Null when the bytes on disk are the survivor's own. */
  claimed: string | null
}

/** Whether a case twin shares this note's file. Ask before the note's row leaves it. */
export function sharesCaseTwinFile(vaultPath: string, relativePath: string): boolean {
  const onDisk = diskCaseOf(vaultPath, relativePath)
  return onDisk !== null && findCanonicalNoteForFile(vaultPath, onDisk)?.sharesFile === true
}

/**
 * Call in the step that drops twin `leavingId`'s row from `relativePath`, with
 * no await since. Null when no single row is left on the file.
 */
export function claimSharedFile(
  vaultPath: string,
  relativePath: string,
  leavingId: string
): SurvivorClaim | null {
  const onDisk = diskCaseOf(vaultPath, relativePath)
  const survivor = onDisk === null ? null : findCanonicalNoteForFile(vaultPath, onDisk)
  if (!survivor || survivor.sharesFile) return null
  const claim = {
    leavingId,
    survivorId: survivor.id,
    survivorPath: survivor.path,
    title: survivor.title,
    claimed: null as string | null
  }
  const indexDb = getIndexDatabase()
  const raw = readVaultFileSync(vaultPath, survivor.path)
  if (
    raw === null ||
    generateContentHash(raw) === getNoteCacheById(indexDb, survivor.id)?.contentHash
  )
    return claim
  recordBaseline(indexDb, survivor.id, raw)
  if (owesFileBody(survivor.id)) clearOwedFileBody(survivor.id)
  log.info('A case twin left a shared file holding bytes that are not the survivor’s', {
    leavingId,
    survivorId: survivor.id
  })
  return { ...claim, claimed: raw }
}

export type SurvivorFileOutcome = 'already-own' | 'written' | 'emptied' | 'failed'

/**
 * Write the survivor's doc over the bytes `claimSharedFile` claimed. Never
 * throws: the leave has already happened, and a failure leaves claimed bytes
 * that only a doc-to-file pass touches.
 */
export async function keepSurvivorFile(claim: SurvivorClaim | null): Promise<SurvivorFileOutcome> {
  if (!claim || claim.claimed === null) return 'already-own'
  const { survivorId, claimed } = claim
  try {
    const provider = getCrdtProvider()
    const live = provider.getDoc(survivorId)
    const doc = live ?? (await provider.open(survivorId, undefined, { skipSeed: true }))
    try {
      if (doc.getXmlFragment(CRDT_FRAGMENT_NAME).length > 0) {
        await writebackNow(survivorId, doc)
        return 'written'
      }
    } finally {
      if (!live) await provider.closeIfInactive(survivorId)
    }
    createSnapshot(survivorId, claimed, claim.title, SnapshotReasons.SIGNIFICANT)
    const absolutePath = toAbsolutePath(claim.survivorPath)
    markWritebackIgnored(absolutePath)
    await writeWithBaseline(getIndexDatabase(), survivorId, '', () => atomicWrite(absolutePath, ''))
    log.warn('The case twin left on a shared file has no doc body; the file was emptied', {
      leavingId: claim.leavingId,
      survivorId
    })
    return 'emptied'
  } catch (error) {
    log.error('Could not write the surviving case twin into the shared file', {
      leavingId: claim.leavingId,
      survivorId,
      error
    })
    trackMainError('notes', 'case_twin_file_survivor', error)
    return 'failed'
  }
}
