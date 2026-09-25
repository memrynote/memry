import {
  RECORD_CLOCK_REQUIRED_ITEM_TYPES,
  RecordPullBlobMissingSchema,
  RecordPullItemResponseSchema,
  RecordPullPurgedTombstoneSchema,
  type RecordClockRequiredItemType,
  type RecordPullItemResponse,
  type VectorClock
} from '@memry/contracts/sync-api'
import { isBinaryFileType } from '@memry/shared/file-types'
import type { DecryptedPullItem } from '@memry/sync-client/worker-protocol'
import { createLogger } from '../../lib/logger'
import {
  verifyTombstoneAttestation,
  type AttestationRefusal,
  type TombstoneAttestation,
  type VerifiedAttestation
} from '../delete-attestation'
import type { DrizzleDb } from '../item-handlers'
import type { ItemRef, ResolveDeviceKey } from './corrupt-item-tracker'
import {
  localTombstoneRefusal,
  readKnownDeviceIds,
  type LocalTombstoneRefusal
} from './purged-tombstone-guard'

const log = createLogger('PullEnvelope')

const CLOCK_REQUIRED_TYPES = new Set<string>(RECORD_CLOCK_REQUIRED_ITEM_TYPES)

/**
 * A purged tombstone the envelope admitted (#2302, protocol 05 §5.12.3): the
 * slice asked for the id, the type carries a required clock, and the clock is
 * non-empty. Admission is not permission: only an AttestedTombstone applies.
 */
export interface PurgedTombstone {
  id: string
  type: RecordClockRequiredItemType
  deletedAt: number
  clock: VectorClock
  /** #2408: present only when the entry names both a signer and a signature. */
  attestation?: TombstoneAttestation
}

/** A purged tombstone whose attestation verified over its own claim (#2408). */
export type AttestedTombstone = PurgedTombstone & { verified: VerifiedAttestation }

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
  const { id, type, deletedAt, clock, signerDeviceId, deleteAttestation } = parsed.data
  if (!requested.has(id)) return { id, type, reason: 'not_requested' }
  if (!CLOCK_REQUIRED_TYPES.has(type)) return { id, type, reason: 'type_not_clocked' }
  if (!clock || Object.keys(clock).length === 0) return { id, type, reason: 'clockless' }
  return {
    id,
    type: type as RecordClockRequiredItemType,
    deletedAt,
    clock,
    ...(signerDeviceId && deleteAttestation
      ? { attestation: { signerDeviceId, signature: deleteAttestation } }
      : {})
  }
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

/**
 * The exact apply input a signed tombstone produces: a delete with its clock
 * and no content. Takes only an attested tombstone (#2408), so an entry no
 * device signed cannot reach the applier.
 */
export function purgedTombstoneToApplyItem(tombstone: AttestedTombstone): DecryptedPullItem {
  return {
    id: tombstone.id,
    type: tombstone.type,
    operation: 'delete',
    content: '',
    clock: tombstone.clock,
    deletedAt: tombstone.deletedAt,
    signerDeviceId: tombstone.verified.signerDeviceId
  }
}

/**
 * The single "may this purged tombstone delete" decision (#2302, #2408), in
 * order: `skip`, the signer's attestation over the entry's own claim, then
 * every local refusal (localTombstoneRefusal); the survivors go to the §5.8
 * handler guard. Refusals are logged by reason and never applied.
 *
 * `unverified` entries carry no proof a device deleted the item, so a caller
 * treats them like an entry the envelope refused. `refused` entries are
 * attested but kept by local evidence. A key the resolver cannot fetch throws:
 * a transient failure must hold the page, never become a refusal.
 */
export async function applicablePurgedTombstones(
  db: DrizzleDb,
  tombstones: readonly PurgedTombstone[],
  resolveKey: ResolveDeviceKey,
  skip: (ref: ItemRef) => boolean = () => false
): Promise<{
  apply: AttestedTombstone[]
  unverified: Array<PurgedTombstone & { reason: AttestationRefusal }>
  refused: Array<AttestedTombstone & { reason: LocalTombstoneRefusal }>
}> {
  const candidates = tombstones.filter((tombstone) => !skip(tombstone))
  const keys = new Map<string, Uint8Array | null>()
  for (const { attestation } of candidates) {
    if (attestation && !keys.has(attestation.signerDeviceId)) {
      keys.set(attestation.signerDeviceId, await resolveKey(attestation.signerDeviceId))
    }
  }

  const unverified: Array<PurgedTombstone & { reason: AttestationRefusal }> = []
  const attested: AttestedTombstone[] = []
  for (const tombstone of candidates) {
    const signer = tombstone.attestation?.signerDeviceId
    const verified = verifyTombstoneAttestation(
      tombstone,
      signer ? (keys.get(signer) ?? null) : null
    )
    if (typeof verified === 'string') unverified.push({ ...tombstone, reason: verified })
    else attested.push({ ...tombstone, verified })
  }

  const knownDevices = attested.length > 0 ? readKnownDeviceIds(db) : null
  const apply: AttestedTombstone[] = []
  const refused: Array<AttestedTombstone & { reason: LocalTombstoneRefusal }> = []
  for (const tombstone of attested) {
    const reason = localTombstoneRefusal(db, tombstone, knownDevices)
    if (reason) refused.push({ ...tombstone, reason })
    else apply.push(tombstone)
  }
  const reasons = [...unverified, ...refused].map(({ reason }) => reason)
  if (reasons.length > 0) logRefusals(reasons)
  return { apply, unverified, refused }
}

const logRefusals = (reasons: readonly string[]): void => {
  const byReason: Record<string, number> = {}
  for (const reason of reasons) byReason[reason] = (byReason[reason] ?? 0) + 1
  log.warn('Pull: refused purged tombstones', byReason)
}

/**
 * The page's purged tombstones as apply items: envelope admission, `skip`
 * (already applied this run, quarantined, or a run from cursor 0), the
 * attestation (#2408), and the local refusals. Never applied otherwise.
 */
export async function purgedTombstoneApplyItems(
  envelope: PullEnvelope,
  skip: (ref: ItemRef) => boolean,
  deps: { db: DrizzleDb; resolveKey: ResolveDeviceKey }
): Promise<DecryptedPullItem[]> {
  if (envelope.refusedTombstones.length > 0) {
    logRefusals(envelope.refusedTombstones.map(({ reason }) => reason))
  }
  const { apply } = await applicablePurgedTombstones(
    deps.db,
    envelope.purgedTombstones,
    deps.resolveKey,
    skip
  )
  return apply.map(purgedTombstoneToApplyItem)
}

/**
 * A note or journal that is not deleted and not a binary file has a CRDT body
 * the pull merges after its record. A payload that does not parse is treated
 * as text.
 */
export function carriesCrdtBody(
  item: { type: string; content: string },
  operation: string
): boolean {
  if ((item.type !== 'note' && item.type !== 'journal') || operation === 'delete') return false
  try {
    const { fileType } = JSON.parse(item.content) as { fileType?: string }
    return !(fileType && isBinaryFileType(fileType))
  } catch {
    return true
  }
}
