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
 * No header means the client predates negotiation, so it gets exactly the
 * frozen legacy list — never the server's current type list, which may contain
 * types that binary would choke on.
 *
 * Unrecognized entries are dropped rather than trusted; an entirely
 * unrecognized header is treated as no header at all.
 */
export function resolveSyncTypes(header: string | undefined | null): RecordSyncItemType[] {
  if (!header) return [...LEGACY_RECORD_SYNC_ITEM_TYPES]

  const negotiated = header
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is RecordSyncItemType => entry.length > 0 && SUPPORTED.has(entry))

  if (negotiated.length === 0) return [...LEGACY_RECORD_SYNC_ITEM_TYPES]

  return negotiated
}
