import { and, eq, inArray, isNull } from 'drizzle-orm'
import { attachmentDownloadFailures, attachmentUploadQueue } from '@memry/db-schema/data-schema'
import { createLogger } from './logging'
import type { DrizzleDb } from './item-handlers/types'

const log = createLogger('AttachmentDownloadState')

/**
 * Whether an attachment download is worth attempting, and what to remember when
 * it settles.
 *
 * Three separate defects made a dead attachment reference cost ~11-16 futile
 * requests per session, forever (issue #1588):
 *
 * 1. the only guard was an in-memory Set cleared on every sync-runtime stop,
 * 2. it recorded that the *emit reached a listener*, not that the *download
 *    succeeded* — so a 404 and a success were indistinguishable to it, and
 * 3. nothing branched on the status code, so a permanent 404 was retried on the
 *    same terms as a transient blip.
 *
 * This module owns all three. Successes stay session-scoped (the file is on
 * disk, so a re-request after a restart is cheap and self-skipping), failures
 * are persisted so they survive a sync stop/start and a relaunch.
 */

/** A 404 is re-probed at most this often, and at most MISSING_PROBE_LIMIT times. */
const MISSING_RETRY_MS = 24 * 60 * 60 * 1000

/**
 * How many separate 404s (each at least MISSING_RETRY_MS apart) it takes before
 * the reference is treated as genuinely gone: no more automatic probes, and
 * `pruneUnresolvableReferences` may drop it from the note's manifest.
 */
export const MISSING_PROBE_LIMIT = 3

const TRANSIENT_BASE_MS = 60 * 1000
const TRANSIENT_MAX_MS = 6 * 60 * 60 * 1000

/**
 * Ceiling on the session cache of successes. Entries are never retired
 * individually, so without one the Set grows by every owner×attachment this
 * device has ever pulled. Insertion order is FIFO, so the oldest key goes
 * first; re-requesting it later is cheap because the downloader skips files
 * that already exist on disk.
 */
const MAX_SUCCEEDED_KEYS = 5000

/** Requests handed to the downloader whose outcome is not in yet. */
const inFlight = new Set<string>()
/** Downloads that succeeded in this session. */
const succeeded = new Set<string>()

const keyOf = (ownerId: string, attachmentId: string): string => `${ownerId}::${attachmentId}`

/** Vault switch / sync-runtime stop: these keys belong to the old vault. */
export function resetAttachmentDownloadSession(): void {
  inFlight.clear()
  succeeded.clear()
}

function rememberSuccess(key: string): void {
  if (succeeded.size >= MAX_SUCCEEDED_KEYS) {
    const oldest = succeeded.values().next().value
    if (oldest !== undefined) succeeded.delete(oldest)
  }
  succeeded.add(key)
}

function readFailure(
  db: DrizzleDb,
  ownerId: string,
  attachmentId: string
): { reason: 'missing' | 'transient'; attempts: number; nextAttemptAt: number | null } | undefined {
  return db
    .select({
      reason: attachmentDownloadFailures.reason,
      attempts: attachmentDownloadFailures.attempts,
      nextAttemptAt: attachmentDownloadFailures.nextAttemptAt
    })
    .from(attachmentDownloadFailures)
    .where(eq(attachmentDownloadFailures.id, keyOf(ownerId, attachmentId)))
    .get()
}

/**
 * A 404 (or 410) on the manifest is the server saying it does not have this
 * attachment and never will — attachment ids are minted per upload, so the id
 * can never be filled in later by re-uploading the same file. Everything else
 * (5xx, network, auth, decrypt) is a blip on the way to a blob that may well
 * exist.
 *
 * Read structurally rather than with `instanceof SyncServerError` /
 * `DeadLetterError`: both live in `http-client`/`retry`, which import electron's
 * `net` at module scope. This module is reached from the note item handler on
 * every pull, so importing them would drag electron into every test that
 * applies a note. `name` + numeric `statusCode` is the same contract those
 * classes publish.
 */
export function isPermanentDownloadFailure(err: unknown): boolean {
  const withLastError = err as { name?: unknown; lastError?: unknown }
  const inner = withLastError?.name === 'DeadLetterError' ? withLastError.lastError : err
  const statusCode = (inner as { statusCode?: unknown })?.statusCode
  return statusCode === 404 || statusCode === 410
}

/**
 * Should this (owner, attachment) download be attempted right now?
 *
 * Fails open: a table that cannot be read must not stop attachments from ever
 * downloading — the worst case is today's behaviour.
 */
export function shouldAttemptDownload(
  db: DrizzleDb,
  ownerId: string,
  attachmentId: string
): boolean {
  const key = keyOf(ownerId, attachmentId)
  if (inFlight.has(key) || succeeded.has(key)) return false

  let row: ReturnType<typeof readFailure>
  try {
    row = readFailure(db, ownerId, attachmentId)
  } catch (err) {
    log.warn('Could not read attachment download failure state', { attachmentId, error: err })
    return true
  }

  if (!row) return true
  // No automatic retry left: the server has 404'd this id on MISSING_PROBE_LIMIT
  // separate days. Re-adding the file mints a NEW attachment id, which has no
  // row here and is therefore never blocked.
  if (row.nextAttemptAt === null) return false
  return Date.now() >= row.nextAttemptAt
}

/** Claim the attempt so concurrent pulls of the same note do not fan out twice. */
export function markDownloadRequested(ownerId: string, attachmentId: string): void {
  inFlight.add(keyOf(ownerId, attachmentId))
}

/**
 * Drop the in-flight claim without recording an outcome — the request never
 * reached the downloader (no listener, no token, no service), so the next pull
 * must be free to ask again.
 */
export function releaseDownloadAttempt(ownerId: string, attachmentId: string): void {
  inFlight.delete(keyOf(ownerId, attachmentId))
}

/** The bytes are on disk. Forget every failure recorded for this attachment. */
export function markDownloadSucceeded(
  db: DrizzleDb | null,
  ownerId: string,
  attachmentId: string
): void {
  const key = keyOf(ownerId, attachmentId)
  inFlight.delete(key)
  rememberSuccess(key)
  if (!db) return
  try {
    db.delete(attachmentDownloadFailures).where(eq(attachmentDownloadFailures.id, key)).run()
  } catch (err) {
    log.warn('Could not clear attachment download failure state', { attachmentId, error: err })
  }
}

/**
 * Record the outcome of a failed download and return how it was classified.
 * A permanent failure stops being probed once it has 404'd MISSING_PROBE_LIMIT
 * times; a transient one keeps retrying on an exponential backoff.
 */
export function markDownloadFailed(
  db: DrizzleDb | null,
  ownerId: string,
  attachmentId: string,
  err: unknown
): 'missing' | 'transient' {
  const key = keyOf(ownerId, attachmentId)
  inFlight.delete(key)
  const permanent = isPermanentDownloadFailure(err)
  const reason = permanent ? 'missing' : 'transient'
  if (!db) return reason

  const now = Date.now()
  const message = err instanceof Error ? err.message : String(err)

  try {
    const previous = readFailure(db, ownerId, attachmentId)
    // Attempts count per reason: a spell of 5xx must not spend the 404 budget,
    // and vice versa.
    const attempts = previous?.reason === reason ? previous.attempts + 1 : 1
    const nextAttemptAt = permanent
      ? attempts >= MISSING_PROBE_LIMIT
        ? null
        : now + MISSING_RETRY_MS
      : now + Math.min(TRANSIENT_BASE_MS * 2 ** (attempts - 1), TRANSIENT_MAX_MS)

    db.insert(attachmentDownloadFailures)
      .values({
        id: key,
        ownerId,
        attachmentId,
        reason,
        attempts,
        lastError: message,
        nextAttemptAt,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: attachmentDownloadFailures.id,
        set: { reason, attempts, lastError: message, nextAttemptAt, updatedAt: now }
      })
      .run()

    if (permanent && nextAttemptAt === null) {
      log.warn('Attachment is not on the server; giving up on it', {
        ownerId,
        attachmentId,
        attempts
      })
    }
  } catch (dbErr) {
    log.warn('Could not record attachment download failure', { attachmentId, error: dbErr })
  }

  return reason
}

/**
 * The attachment was (re-)uploaded from this device, so any recorded failure for
 * it is stale. The way back for a reference this device had given up on.
 */
export function clearAttachmentDownloadFailure(
  db: DrizzleDb,
  ownerId: string,
  attachmentId: string
): void {
  try {
    db.delete(attachmentDownloadFailures)
      .where(eq(attachmentDownloadFailures.id, keyOf(ownerId, attachmentId)))
      .run()
  } catch (err) {
    log.warn('Could not clear attachment download failure state', { attachmentId, error: err })
  }
}

/**
 * Drop references the server has definitively lost from a note's manifest.
 *
 * `attachmentReferences` merges union-only, so without this a reference to a
 * deleted attachment lives in the note's sync payload forever and is handed to
 * every device that ever pulls the note.
 *
 * A reference is only safe to drop on POSITIVE evidence of absence, never on
 * absence of evidence:
 *
 * - this device asked the server for that exact manifest and got a 404, on
 *   MISSING_PROBE_LIMIT separate occasions a day apart (`nextAttemptAt IS NULL`
 *   with reason 'missing'), AND
 * - the note owes the server no upload — a pending `attachment_upload_queue`
 *   row means bytes for this note are still on their way up, which is exactly
 *   the "not yet synced" case that must never be pruned.
 *
 * An id that has merely never been probed has no row here and is therefore
 * never dropped. Nothing on disk is ever deleted.
 */
export function pruneUnresolvableReferences(
  db: DrizzleDb,
  noteId: string,
  refs: string[]
): string[] {
  if (refs.length === 0) return refs

  try {
    const pendingUpload = db
      .select({ noteId: attachmentUploadQueue.noteId })
      .from(attachmentUploadQueue)
      .where(eq(attachmentUploadQueue.noteId, noteId))
      .get()
    if (pendingUpload) return refs

    const gone = db
      .select({ attachmentId: attachmentDownloadFailures.attachmentId })
      .from(attachmentDownloadFailures)
      .where(
        and(
          eq(attachmentDownloadFailures.ownerId, noteId),
          eq(attachmentDownloadFailures.reason, 'missing'),
          // Same flag the request path reads as "no automatic retry left".
          isNull(attachmentDownloadFailures.nextAttemptAt),
          inArray(attachmentDownloadFailures.attachmentId, refs)
        )
      )
      .all()

    if (gone.length === 0) return refs
    const drop = new Set(gone.map((row) => row.attachmentId))

    const kept = refs.filter((id) => !drop.has(id))
    log.warn('Dropping attachment references the server does not have', {
      noteId,
      dropped: drop.size
    })
    return kept
  } catch (err) {
    log.warn('Could not prune attachment references', { noteId, error: err })
    return refs
  }
}
