import { and, ne, notLike, type SQL } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { PACK_SEEDED_KEY_PREFIX } from './engine/pack-seeded-docs'
import { SYNC_STATE_KEYS } from './engine/sync-context'
import { JOURNAL_CLOCK_ERA_KEY } from './journal-clock-era'
import { JOURNAL_DAY_MERGE_KEY_PREFIX } from './journal-day-merge-key'

/**
 * The `sync_state` rows sign-out keeps: device-local facts that outlive a
 * session. Sign-out wipes every other row, so a new device-local key is lost
 * on the first sign-out unless it is added here.
 *
 * - The pack settle markers and their flag describe the per-vault CRDT store,
 *   which sign-out keeps. Dropped, a packed body stays in its doc and never
 *   reaches the file, because the doc's watermark stops the next sign-in from
 *   offering the pack again (#2462).
 * - The journal clock era dates when this vault first opened under a build
 *   that stamps journal push acks (#5659). Re-dated at the next sign-in, it
 *   reads an edit made before the sign-out as an older build's, and the dirty
 *   sweep replays it: the server refuses the replay, and its ack stamps the
 *   journal clean without the edit reaching the server.
 * - An owed journal day merge holds the only copy of a displaced holder's
 *   tags and file text while the drain waits for the foreign body (#5699).
 *   Wiped, an offline tag on a blank holder never reaches the day, since the
 *   next sign-in has no holder left to owe it again.
 */
const KEEP_KEYS: readonly string[] = [
  SYNC_STATE_KEYS.PACK_SEED_SETTLE_PENDING,
  JOURNAL_CLOCK_ERA_KEY
]
const KEEP_PREFIXES: readonly string[] = [PACK_SEEDED_KEY_PREFIX, JOURNAL_DAY_MERGE_KEY_PREFIX]

/** Every `sync_state` row a session owns: the complement of the keep-set. */
export function sessionState(): SQL | undefined {
  return and(
    ...KEEP_KEYS.map((key) => ne(syncState.key, key)),
    ...KEEP_PREFIXES.map((prefix) => notLike(syncState.key, `${prefix}%`))
  )
}
