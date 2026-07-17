import {
  LEGACY_RECORD_SYNC_ITEM_TYPES,
  RECORD_SYNC_ITEM_TYPES,
  type RecordSyncItemType
} from '@memry/contracts/sync-api'

export const SYNC_TYPES_HEADER = 'X-Memry-Sync-Types'

const SUPPORTED = new Set<string>(RECORD_SYNC_ITEM_TYPES)

/**
 * Resolve the item types a client is willing to receive.
 *
 * No header vs. an unrecognized header are different situations and must
 * resolve differently:
 *
 * - **No header at all** means the client predates negotiation entirely — it
 *   never declared anything, so it gets exactly the frozen legacy list. This
 *   is the property that protects binaries already in users' hands; never
 *   change it.
 * - **Header present but nothing in it recognized** means the client DID
 *   negotiate — we just failed to parse any of what it declared (e.g. a
 *   corrupted proxy, a future header format). Falling back to legacy here
 *   would hand that client 15 types it never asked for, which is the exact
 *   convergence-loss bug this feature exists to prevent. It must resolve to
 *   an empty list instead, serving zero rows rather than guessing.
 *
 * Recognized entries are deduped (first-seen order preserved) because the
 * header is unbounded client input: `note,note,note,...` must not multiply
 * `types.length` past what the server actually supports. Since every
 * surviving entry is already a member of `RECORD_SYNC_ITEM_TYPES`, deduping
 * structurally bounds the result to that set's size — no separate cap needed.
 */
export function resolveSyncTypes(header: string | undefined | null): RecordSyncItemType[] {
  if (!header) return [...LEGACY_RECORD_SYNC_ITEM_TYPES]

  const seen = new Set<RecordSyncItemType>()
  for (const raw of header.split(',')) {
    const entry = raw.trim()
    if (entry.length > 0 && SUPPORTED.has(entry)) {
      seen.add(entry as RecordSyncItemType)
    }
  }

  return [...seen]
}
