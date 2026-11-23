/**
 * A peer replaced the bytes of a binary note with no synced hash recorded
 * (#5608): a note from before #5603, or one whose sync_state a session
 * teardown cleared. The replace marks its file as holding a change on no
 * server, so without this every receiving device would keep the file as a
 * conflict copy. The check compares the file with the manifest checksum of the
 * attachment the note named before the replace. When they match, the file
 * holds bytes a server has: its mark and its synced hash take their sha256,
 * and the landing replaces them with no copy. Other bytes, a manifest that
 * cannot be read in time, or a restart before the answer leave the mark, and
 * the landing keeps a copy. A failed check never lets the landing overwrite.
 *
 * @module sync/binary-hash-check
 */

import { getNoteMetadataById } from '@memry/storage-data'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { createLogger } from '../lib/logger'
import { markHeldFileOnServer } from '../vault/case-twin-bytes'
import { hashFileOffThread } from '../vault/file-hash-bridge'
import { toAbsolutePath } from '../vault/notes-io'
import { recordSyncedBinaryHash } from './binary-synced-hash'

const log = createLogger('BinaryHashCheck')

/** How long a landing waits for one check: the manifest fetch with its retries, then the hash. */
const CHECK_DEADLINE_MS = 30_000

type ChecksumReader = (attachmentId: string) => Promise<string>

let readChecksum: ChecksumReader | null = null
/** One check at a time: a pull that replaces many notes asks for one manifest at a time. */
let tail: Promise<void> = Promise.resolve()
const checks = new Map<string, Promise<void>>()

/** The attachment service's manifest reader. Null while sync is down: no check runs. */
export function registerManifestChecksumReader(reader: ChecksumReader | null): void {
  readChecksum = reader
}

/** Start comparing note `noteId`'s file at `filePath` with attachment `attachmentId`. */
export function checkUnhashedBinaryFile(
  db: DrizzleDb,
  noteId: string,
  attachmentId: string,
  filePath: string
): void {
  const reader = readChecksum
  if (!reader) return
  const check = tail
    .then(() => compare(db, noteId, attachmentId, filePath, reader))
    .catch((error: unknown) => {
      log.warn(
        'A binary note file was not compared with its attachment; it stays a conflict copy',
        {
          noteId,
          attachmentId,
          error
        }
      )
    })
  tail = check
  checks.set(noteId, check)
  void check.then(() => {
    if (checks.get(noteId) === check) checks.delete(noteId)
  })
}

/** Before a download lands on note `noteId`'s file: wait for its check. Never rejects. */
export async function settleBinaryHashCheck(noteId: string): Promise<void> {
  await checks.get(noteId)
}

async function compare(
  db: DrizzleDb,
  noteId: string,
  attachmentId: string,
  filePath: string,
  reader: ChecksumReader
): Promise<void> {
  const onServer = await withinDeadline(
    (async () => {
      const checksum = await reader(attachmentId)
      const onDisk = await hashFileOffThread(filePath)
      return onDisk === checksum ? onDisk : null
    })()
  )
  if (onServer === null) return
  // A rename since the replace moved the file away from the bytes compared.
  const note = getNoteMetadataById(db, noteId)
  if (!note || toAbsolutePath(note.path) !== filePath) return
  if (markHeldFileOnServer(db, noteId, onServer)) recordSyncedBinaryHash(db, noteId, onServer)
}

function withinDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`No answer within ${CHECK_DEADLINE_MS} ms`)),
      CHECK_DEADLINE_MS
    )
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}
