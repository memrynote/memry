import {
  RECORD_CLOCK_REQUIRED_ITEM_TYPES,
  RecordPullBlobMissingSchema,
  RecordPullItemResponseSchema,
  RecordPullPurgedTombstoneSchema,
  type RecordClockRequiredItemType,
  type RecordPullItemResponse,
  type VectorClock
} from '@memry/contracts/sync-api'
import type { DecryptedPullItem } from '@memry/sync-client/worker-protocol'
import { createLogger } from '../../lib/logger'
import type { DrizzleDb } from '../item-handlers'
import type { ItemRef } from './corrupt-item-tracker'
import {
  localTombstoneRefusal,
  readKnownDeviceIds,
  type LocalTombstoneRefusal
} from './purged-tombstone-guard'

const log = createLogger('PullEnvelope')

const CLOCK_REQUIRED_TYPES = new Set<string>(RECORD_CLOCK_REQUIRED_ITEM_TYPES)

/**
 * A purged tombstone admitted for apply (#2302, protocol 05 §5.12.3). The
 * entry is unsigned, so admission is the whole policy: the slice asked for
 * the id, the type carries a required clock, and the clock is non-empty. The
 * clock then goes through the same §5.8 handler guard as a signed tombstone.
 */
export interface PurgedTombstone {
  id: string
  type: RecordClockRequiredItemType
  deletedAt: number
  clock: VectorClock
}

export type RefusedTombstoneReason = 'not_requested' | 'clockless' | 'type_not_clocked' | 'shape'

export interface RefusedTombstone {
  id?: string
  type?: string
  reason: RefusedTombstoneReason
}

export interface PullEnvelope {
  kind: 'envelope'
  items: RecordPullItemResponse[]
  invalid: ItemRef[]
  unnamed: number
  purgedTombstones: PurgedTombstone[]
  refusedTombstones: RefusedTombstone[]
  /** Live rows whose payload the server lost (#2302): record them, never apply or delete. */
  blobMissing: ItemRef[]
}

export type ParsedPullBody = { kind: 'not_envelope' } | PullEnvelope

const siblingEntries = (body: unknown, key: 'purgedTombstones' | 'blobMissing'): unknown[] => {
  const raw = (body as Record<string, unknown>)[key]
  return Array.isArray(raw) ? raw : []
}

function admitTombstone(
  raw: unknown,
  requested: ReadonlySet<string>
): PurgedTombstone | RefusedTombstone {
  const parsed = RecordPullPurgedTombstoneSchema.safeParse(raw)
  if (!parsed.success) {
    const ref = raw as { id?: unknown; type?: unknown } | null
    return {
      ...(typeof ref?.id === 'string' ? { id: ref.id } : {}),
      ...(typeof ref?.type === 'string' ? { type: ref.type } : {}),
      reason: 'shape'
    }
  }
  const { id, type, deletedAt, clock } = parsed.data
  if (!requested.has(id)) return { id, type, reason: 'not_requested' }
  if (!CLOCK_REQUIRED_TYPES.has(type)) return { id, type, reason: 'type_not_clocked' }
  if (!clock || Object.keys(clock).length === 0) return { id, type, reason: 'clockless' }
  return { id, type: type as RecordClockRequiredItemType, deletedAt, clock }
}

/**
 * Parses a `/sync/pull` response per item, never per page (protocol 05 §5.14).
 * An item that fails the envelope schema but names an id and type lands in
 * `invalid`; one that names neither is only counted.
 *
 * `inline` items from the same `/sync/changes` page (#2292) are parsed first,
 * under the same rules. A body that is not a pull envelope is still
 * `not_envelope` when inline items exist: the slice is refused and the cursor
 * holds (#2285).
 *
 * `requestedIds` are the ids the request named. Only they may be deleted by a
 * `purgedTombstones` entry or recorded from a `blobMissing` entry (#2302).
 */
export function parsePullItems(
  body: unknown,
  inline: readonly unknown[] = [],
  requestedIds: readonly string[] = []
): ParsedPullBody {
  const rawItems = (body as { items?: unknown } | null)?.items
  if (!Array.isArray(rawItems)) return { kind: 'not_envelope' }

  const items: RecordPullItemResponse[] = []
  const invalid: ItemRef[] = []
  let unnamed = 0
  for (const raw of [...inline, ...rawItems]) {
    const parsed = RecordPullItemResponseSchema.safeParse(raw)
    if (parsed.success) {
      items.push(parsed.data)
      continue
    }
    const ref = raw as { id?: unknown; type?: unknown } | null
    if (typeof ref?.id === 'string' && typeof ref.type === 'string') {
      invalid.push({ id: ref.id, type: ref.type })
    } else {
      unnamed++
    }
  }

  const requested = new Set(requestedIds)
  const purgedTombstones: PurgedTombstone[] = []
  const refusedTombstones: RefusedTombstone[] = []
  for (const raw of siblingEntries(body, 'purgedTombstones')) {
    const entry = admitTombstone(raw, requested)
    if ('reason' in entry) refusedTombstones.push(entry)
    else purgedTombstones.push(entry)
  }
  const blobMissing = siblingEntries(body, 'blobMissing').flatMap((raw) => {
    const parsed = RecordPullBlobMissingSchema.safeParse(raw)
    return parsed.success && requested.has(parsed.data.id)
      ? [{ id: parsed.data.id, type: parsed.data.type }]
      : []
  })

  return {
    kind: 'envelope',
    items,
    invalid,
    unnamed,
    purgedTombstones,
    refusedTombstones,
    blobMissing
  }
}

/** The exact apply input a signed tombstone produces: a delete with its clock and no content. */
export function purgedTombstoneToApplyItem(tombstone: PurgedTombstone): DecryptedPullItem {
  return {
    id: tombstone.id,
    type: tombstone.type,
    operation: 'delete',
    content: '',
    clock: tombstone.clock,
    deletedAt: tombstone.deletedAt,
    // Never attributed to a device: the server, not a signer, asserts this delete.
    signerDeviceId: ''
  }
}

/**
 * The admitted purged tombstones this device may apply (#2302): minus the refs
 * `skip` names, then minus every local refusal (localTombstoneRefusal).
 * Refusals are logged by reason and never applied.
 */
export function applicablePurgedTombstones(
  db: DrizzleDb,
  tombstones: readonly PurgedTombstone[],
  skip: (ref: ItemRef) => boolean = () => false
): {
  apply: PurgedTombstone[]
  refused: Array<PurgedTombstone & { reason: LocalTombstoneRefusal }>
} {
  const knownDevices = tombstones.length > 0 ? readKnownDeviceIds(db) : null
  const apply: PurgedTombstone[] = []
  const refused: Array<PurgedTombstone & { reason: LocalTombstoneRefusal }> = []
  for (const tombstone of tombstones) {
    if (skip(tombstone)) continue
    const reason = localTombstoneRefusal(db, tombstone, knownDevices)
    if (reason) refused.push({ ...tombstone, reason })
    else apply.push(tombstone)
  }
  if (refused.length > 0) logRefusals(refused.map(({ reason }) => reason))
  return { apply, refused }
}

const logRefusals = (reasons: readonly string[]): void => {
  const byReason: Record<string, number> = {}
  for (const reason of reasons) byReason[reason] = (byReason[reason] ?? 0) + 1
  log.warn('Pull: refused purged tombstones', byReason)
}

/**
 * The page's purged tombstones as apply items: envelope admission, `skip`
 * (already applied this run, quarantined, or a run from cursor 0), and the
 * local refusals. Never applied otherwise.
 */
export function purgedTombstoneApplyItems(
  envelope: PullEnvelope,
  skip: (ref: ItemRef) => boolean,
  db: DrizzleDb
): DecryptedPullItem[] {
  if (envelope.refusedTombstones.length > 0) {
    logRefusals(envelope.refusedTombstones.map(({ reason }) => reason))
  }
  return applicablePurgedTombstones(db, envelope.purgedTombstones, skip).apply.map(
    purgedTombstoneToApplyItem
  )
}
