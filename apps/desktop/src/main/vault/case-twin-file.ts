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
 * 2. `claimSharedFile`, before anything of the leave reaches the index or a
 *    peer: a local delete claims in its tombstone's step, before the tombstone
 *    is queued (`deleteNoteCommand`), a peer's delete right before the row
 *    drop. It does every fallible step of the leave, so a throw aborts the
 *    delete with both rows, the file, and the sync queue as they were. While
 *    both rows name the file no write-back touches it (`refusesCaseTwinFile`),
 *    so the claim holds until the drop. Bytes that are not the
 *    survivor's own are named its baseline, so from then on no pass reads them
 *    into its doc as an outside edit, and an owed file body
 *    (`crdt-owed-file-body.ts`) is cleared with them: the bytes it owed are
 *    gone, and a take would read the leaving twin's body. The survivor's own
 *    header is read from its index rows: header tags, properties, aliases, and
 *    a wash cover. An image cover's framing and credit are not indexed, so it
 *    is left out of the file rather than written with reset framing. Its cover
 *    marker is cleared, so its next push omits a cover the file lost instead of
 *    removing it on peers, which keep theirs.
 * 3. `keepSurvivorFile`, after the drop: writes the survivor's own header over
 *    the claimed bytes (kept as one of its versions), then its doc's body. A
 *    survivor with an empty doc keeps the header alone; its body comes with
 *    its next server merge. A crash between steps leaves bytes that only a
 *    doc-to-file pass touches.
 *
 * @module vault/case-twin-file
 */

import { getCrdtProvider } from '../sync/crdt-provider'
import { markWritebackIgnored, writebackNow } from '../sync/crdt-writeback'
import { clearOwedFileBody, owesFileBody } from '../sync/crdt-owed-file-body'
import { recordBaseline, writeWithBaseline } from '../sync/writeback-baseline'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { SnapshotReasons } from '@memry/db-schema/schema/notes-cache'
import { parseCoverValue } from '@memry/shared/cover-image'
import {
  getAliasesForNotes,
  getNoteCacheById,
  getNoteHeaderTags,
  getNotePropertiesAsRecord
} from '@main/database/queries/notes'
import { getNoteMetadataById } from '@memry/storage-data'
import { applyRemoteFrontmatter } from '../sync/item-handlers/note-handler-frontmatter'
import { clearNoteCoverMarker } from '../sync/item-handlers/note-cover-sync'
import { getDatabase, getIndexDatabase } from '../database'
import { readVaultFileSync } from '../lib/paths'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { diskCaseOf } from './disk-case'
import { atomicWrite } from './file-ops'
import { generateContentHash, serializeNote, type NoteFrontmatter } from './frontmatter'
import { findCanonicalNoteForFile, listCaseTwinIds } from './note-sync'
import { toAbsolutePath } from './notes-io'
import { createSnapshot } from './notes-versions'

const log = createLogger('CaseTwinFile')

/** The twin left on a shared file, and the bytes there that are not its own. */
export interface SurvivorClaim {
  leavingId: string
  survivorId: string
  survivorPath: string
  /** Null when the bytes on disk are the survivor's own. */
  claimed: string | null
  /** The survivor's own frontmatter, from its index rows. */
  header: NoteFrontmatter
}

/** Whether a case twin shares this note's file. Ask before the note's row leaves it. */
export function sharesCaseTwinFile(vaultPath: string, relativePath: string): boolean {
  const onDisk = diskCaseOf(vaultPath, relativePath)
  return onDisk !== null && findCanonicalNoteForFile(vaultPath, onDisk)?.sharesFile === true
}

/**
 * Call before twin `leavingId`'s row leaves `relativePath`, and before a local
 * delete queues its tombstone. Throws, with nothing changed that the leave
 * depends on, when the file cannot be read. Null when the leave leaves no
 * single row on the file.
 */
export function claimSharedFile(
  vaultPath: string,
  relativePath: string,
  leavingId: string
): SurvivorClaim | null {
  const onDisk = diskCaseOf(vaultPath, relativePath)
  const twins = onDisk === null ? [] : listCaseTwinIds(vaultPath, onDisk, leavingId)
  if (twins.length !== 1) return null
  const survivorId = twins[0]
  const dataDb = getDatabase()
  const survivor = getNoteMetadataById(dataDb, survivorId)
  if (!survivor) return null
  const indexDb = getIndexDatabase()
  const cached = getNoteCacheById(indexDb, survivorId)
  const raw = readVaultFileSync(vaultPath, survivor.path)
  const claim: SurvivorClaim = {
    leavingId,
    survivorId,
    survivorPath: survivor.path,
    claimed: null,
    header: {}
  }
  if (raw === null || generateContentHash(raw) === cached?.contentHash) return claim
  const cover = cached?.cover ?? null
  const header = applyRemoteFrontmatter(
    {},
    {
      tags: getNoteHeaderTags(indexDb, survivorId),
      properties: getNotePropertiesAsRecord(indexDb, survivorId),
      aliases: getAliasesForNotes(indexDb, [survivorId]).get(survivorId) ?? [],
      ...(cover !== null && parseCoverValue(cover)?.kind === 'wash'
        ? { cover: { ref: cover } }
        : {}),
      title: survivor.title
    }
  )
  recordBaseline(indexDb, survivorId, raw)
  if (owesFileBody(survivorId)) clearOwedFileBody(survivorId)
  clearNoteCoverMarker(dataDb, survivorId)
  log.info('A case twin leaves a shared file holding bytes that are not the survivor’s', {
    leavingId,
    survivorId
  })
  return { ...claim, claimed: raw, header }
}

export type SurvivorFileOutcome = 'already-own' | 'written' | 'header-only' | 'failed'

/**
 * Write the survivor's doc over the bytes `claimSharedFile` claimed. Never
 * throws: the leave has already happened, and a failure leaves claimed bytes
 * that only a doc-to-file pass touches.
 */
export async function keepSurvivorFile(claim: SurvivorClaim | null): Promise<SurvivorFileOutcome> {
  if (!claim || claim.claimed === null) return 'already-own'
  const { survivorId, claimed } = claim
  try {
    const title = getNoteMetadataById(getDatabase(), survivorId)?.title ?? ''
    createSnapshot(survivorId, claimed, title, SnapshotReasons.SIGNIFICANT)
    // The survivor's own header first: the write-back keeps the file's
    // frontmatter, so it must not find the leaving twin's there.
    // Ending in a newline, so the body written under it keeps its final one.
    const header = serializeNote(claim.header, '')
    const headerOnly = header.endsWith('\n') ? header : `${header}\n`
    const absolutePath = toAbsolutePath(claim.survivorPath)
    markWritebackIgnored(absolutePath)
    await writeWithBaseline(getIndexDatabase(), survivorId, headerOnly, () =>
      atomicWrite(absolutePath, headerOnly)
    )
    const provider = getCrdtProvider()
    const live = provider.getDoc(survivorId)
    const doc = live ?? (await provider.open(survivorId, undefined, { skipSeed: true }))
    try {
      if (doc.getXmlFragment(CRDT_FRAGMENT_NAME).length === 0) {
        log.warn('The case twin left on a shared file has no doc body; it keeps its header', {
          leavingId: claim.leavingId,
          survivorId
        })
        return 'header-only'
      }
      await writebackNow(survivorId, doc)
      return 'written'
    } finally {
      if (!live) await provider.closeIfInactive(survivorId)
    }
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
