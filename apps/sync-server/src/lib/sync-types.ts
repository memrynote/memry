import {
  LEGACY_RECORD_SYNC_ITEM_TYPES,
  RECORD_SYNC_ITEM_TYPES,
  type FeedOnlySyncType,
  type RecordSyncItemType
} from '@memry/contracts/sync-api'

export const SYNC_TYPES_HEADER = 'X-Memry-Sync-Types'

const RECORD_TYPES = new Set<string>(RECORD_SYNC_ITEM_TYPES)
const NOTE_BODY: FeedOnlySyncType = 'note_body'

/**
 * What one request may receive, parsed once from `X-Memry-Sync-Types`.
 *
 * `recordTypes` is what the manifest, /sync/pull, bootstrap and the record half
 * of /sync/changes filter sync_items on. It can never hold a feed-only type, so
 * `note_body` cannot reach any of those queries (#2295).
 */
export interface SyncSubscription {
  recordTypes: readonly RecordSyncItemType[]
  /** The client declared `note_body`: /sync/changes also serves CRDT body rows. */
  noteBodies: boolean
}

export const LEGACY_SYNC_SUBSCRIPTION: SyncSubscription = {
  recordTypes: [...LEGACY_RECORD_SYNC_ITEM_TYPES],
  noteBodies: false
}

/**
 * Resolve what a client is willing to receive.
 *
 * No header vs. an unrecognized header are different situations and must
 * resolve differently:
 *
 * - **No header at all** means the client predates negotiation entirely — it
 *   never declared anything, so it gets exactly the frozen legacy list and no
 *   note bodies. This is the property that protects binaries already in users'
 *   hands; never change it.
 * - **Header present but nothing in it recognized** means the client DID
 *   negotiate — we just failed to parse any of what it declared (e.g. a
 *   corrupted proxy, a future header format). Falling back to legacy here
 *   would hand that client 15 types it never asked for, which is the exact
 *   convergence-loss bug this feature exists to prevent. It must resolve to
 *   nothing instead, serving zero rows rather than guessing.
 *
 * Recognized entries are deduped (first-seen order preserved) because the
 * header is unbounded client input: `note,note,note,...` must not multiply
 * `recordTypes.length` past what the server actually supports. Since every
 * surviving entry is already a member of `RECORD_SYNC_ITEM_TYPES`, deduping
 * structurally bounds the result to that set's size — no separate cap needed.
 */
export function resolveSyncSubscription(header: string | undefined | null): SyncSubscription {
  if (!header) return { recordTypes: [...LEGACY_RECORD_SYNC_ITEM_TYPES], noteBodies: false }

  const recordTypes = new Set<RecordSyncItemType>()
  let noteBodies = false
  for (const raw of header.split(',')) {
    const entry = raw.trim()
    if (entry === NOTE_BODY) {
      noteBodies = true
    } else if (RECORD_TYPES.has(entry)) {
      recordTypes.add(entry as RecordSyncItemType)
    }
  }

  return { recordTypes: [...recordTypes], noteBodies }
}
