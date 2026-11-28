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
import type { DownloadNetOptions } from './attachments'
import { recordLandedBinaryHash } from './binary-synced-hash'

const log = createLogger('BinaryHashCheck')

/**
 * How long a landing waits for its check, from the replace that started it:
 * the landing holds a download slot meanwhile, so checks queued ahead of it
 * share the wait instead of adding theirs (#5617). A check whose deadline
 * passed in the queue reads no manifest, and one that runs out aborts its read.
 * Waits for the downloads' pacer are not counted, up to PACED_ALLOWANCE_MS:
 * they pace the downloads too.
 */
const CHECK_DEADLINE_MS = 30_000
/** Pacer waits left out of a check's deadline, at most: a pacer burst holds the slot no longer. */
const PACED_ALLOWANCE_MS = 30_000

export interface ManifestChecksumReader {
  checksumOf(attachmentId: string, net: DownloadNetOptions): Promise<string>
  /** A token from the downloads' pacer: a read spends the server's blob_download budget. */
  pace(): Promise<void>
}

let readChecksum: ManifestChecksumReader | null = null
/** One check at a time: a pull that replaces many notes asks for one manifest at a time. */
let tail: Promise<void> = Promise.resolve()
const checks = new Map<string, Promise<void>>()
/** Time checks waited for the pacer, which deadlines leave out up to their allowance. */
let pacedMs = 0

/** The attachment service's manifest reader. Null while sync is down: no check runs. */
export function registerManifestChecksumReader(reader: ManifestChecksumReader | null): void {
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
  const clock = deadlineClock()
  const check = tail
    .then(() => compare(db, noteId, attachmentId, filePath, reader, clock))
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
  reader: ManifestChecksumReader,
  clock: DeadlineClock
): Promise<void> {
  const onServer = await withinDeadline(clock, reader, async (net) => {
    const checksum = await reader.checksumOf(attachmentId, net)
    const onDisk = await hashFileOffThread(filePath)
    return onDisk === checksum ? onDisk : null
  })
  if (onServer === null) return
  // A rename since the replace moved the file away from the bytes compared.
  const note = getNoteMetadataById(db, noteId)
  if (!note || toAbsolutePath(note.path) !== filePath) return
  if (markHeldFileOnServer(db, noteId, onServer)) recordLandedBinaryHash(db, noteId, onServer)
}

interface DeadlineClock {
  /** The time since the replace that counts against its check's deadline. */
  spent(): number
  /** The pacer wait the deadline still leaves out. */
  allowance(): number
}

function deadlineClock(): DeadlineClock {
  const start = performance.now()
  const pacedAtStart = pacedMs
  const paced = (): number => Math.min(pacedMs - pacedAtStart, PACED_ALLOWANCE_MS)
  return {
    spent: () => performance.now() - start - paced(),
    allowance: () => PACED_ALLOWANCE_MS - paced()
  }
}

async function withinDeadline<T>(
  clock: DeadlineClock,
  reader: ManifestChecksumReader,
  work: (net: DownloadNetOptions) => Promise<T>
): Promise<T> {
  const timedOut = new Error(`No answer within ${CHECK_DEADLINE_MS} ms`)
  if (clock.spent() >= CHECK_DEADLINE_MS) throw timedOut
  const controller = new AbortController()
  const { signal } = controller
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (extraMs = 0): void => {
    timer = setTimeout(
      () => controller.abort(timedOut),
      CHECK_DEADLINE_MS - clock.spent() + extraMs
    )
  }
  const pace = async (): Promise<void> => {
    clearTimeout(timer)
    arm(clock.allowance())
    const from = performance.now()
    try {
      await reader.pace()
    } finally {
      pacedMs += performance.now() - from
      clearTimeout(timer)
      if (!signal.aborted) arm()
    }
  }
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(timedOut), { once: true })
  })
  arm()
  try {
    return await Promise.race([work({ signal, pace }), aborted])
  } finally {
    clearTimeout(timer)
  }
}
