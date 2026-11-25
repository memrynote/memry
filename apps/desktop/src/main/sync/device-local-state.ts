import { and, ne, notLike, type SQL } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { CASE_TWIN_MARK_PREFIX } from '../vault/case-twin-mark-key'
import { PACK_SEEDED_KEY_PREFIX } from './engine/pack-seeded-docs'
import { SYNC_STATE_KEYS } from './engine/sync-context'
import { COVER_MARKER_KEY_PREFIX } from './item-handlers/note-cover-marker-key'
import { JOURNAL_CLOCK_ERA_KEY } from './journal-clock-era'
import { JOURNAL_DAY_MERGE_KEY_PREFIX } from './journal-day-merge-key'

/**
 * The `sync_state` rows sign-out keeps: device-local facts that outlive a
 * session. Sign-out wipes every other row, so a new device-local key is lost
 * on the first sign-out unless it is added here.
 *
 * The rule: a key that describes this device's files or stores outlives the
 * session; a key that describes the server session does not. The cursor and
 * its repairs, the pack watermarks, quarantined and schema-refused items, the
 * synced binary hashes, the text blobs and the heal verdicts describe what a
 * server holds or served, and wiping them costs at most a re-pull, a re-heal
 * or a conflict copy.
 *
 * - The pack settle markers and their flag describe the per-vault CRDT store,
 *   which sign-out keeps. Dropped, a packed body stays in its doc and never
 *   reaches the file, because the doc's watermark stops the next sign-in from
 *   offering the pack again (#2462).
 * - The CRDT store epoch ties the data DB to that store (#2299). Wiped, the
 *   next start reads a mismatch and owes a body sweep of every note. The
 *   unmerged-debt flag and its mirror marker go with it: a mismatch raises the
 *   flag and writes the epoch together, and the engine converts the flag into
 *   debts later, so keeping the epoch without the flag would drop the debt.
 * - The journal clock era dates when this vault first opened under a build
 *   that stamps journal push acks (#5659). Re-dated at the next sign-in, it
 *   reads an edit made before the sign-out as an older build's, and the dirty
 *   sweep replays it: the server refuses the replay, and its ack stamps the
 *   journal clean without the edit reaching the server.
 * - An owed journal day merge holds the only copy of a displaced holder's
 *   tags and file text while the drain waits for the foreign body (#5699).
 *   Wiped, an offline tag on a blank holder never reaches the day, since the
 *   next sign-in has no holder left to owe it again.
 * - The case twin holds describe files two notes share on a case-insensitive
 *   disk (#5522, #5560, #5585): a file that may hold a twin's bytes, the
 *   changes the watcher held, the bytes a landing left and the conflict copies
 *   it kept. Wiped, the watcher pushes a twin's bytes as the note's own after
 *   the next sign-in and overwrites that note on every device (#5754). The
 *   bare foreign-bytes key is the one-row form of older builds.
 * - The note cover markers record which cover this device's file held, and a
 *   cover framing that lives only in the file. Wiped, a cover removed here is
 *   never pushed, and a rebuilt file pushes its bare cover over the framing
 *   peers keep.
 * - The upload refusals name files of this device that fail the same way on
 *   every upload (#5606). Wiped, the backfill offers each of them again.
 */
const KEEP_KEYS: readonly string[] = [
  SYNC_STATE_KEYS.PACK_SEED_SETTLE_PENDING,
  SYNC_STATE_KEYS.CRDT_STORE_EPOCH,
  SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT,
  SYNC_STATE_KEYS.CRDT_BODY_DEBT_MIRROR_AT,
  JOURNAL_CLOCK_ERA_KEY,
  SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES,
  SYNC_STATE_KEYS.CASE_TWIN_HELD_CHANGES,
  SYNC_STATE_KEYS.CASE_TWIN_LANDED_HASHES,
  SYNC_STATE_KEYS.CASE_TWIN_KEPT_COPIES,
  SYNC_STATE_KEYS.ATTACHMENT_UPLOAD_REFUSALS
]
const KEEP_PREFIXES: readonly string[] = [
  PACK_SEEDED_KEY_PREFIX,
  JOURNAL_DAY_MERGE_KEY_PREFIX,
  CASE_TWIN_MARK_PREFIX,
  COVER_MARKER_KEY_PREFIX
]

/** Every `sync_state` row a session owns: the complement of the keep-set. */
export function sessionState(): SQL | undefined {
  return and(
    ...KEEP_KEYS.map((key) => ne(syncState.key, key)),
    ...KEEP_PREFIXES.map((prefix) => notLike(syncState.key, `${prefix}%`))
  )
}
