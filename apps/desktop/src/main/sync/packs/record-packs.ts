import {
  RECORD_SYNC_ITEM_TYPES,
  RecordPackEntryMetaSchema,
  RecordPullItemResponseSchema,
  RecordSyncManifestItemSchema,
  type PackCoverage,
  type PackSummary,
  type RecordPullItemResponse,
  type RecordSyncManifest
} from '@memry/contracts/sync-api'

import { createLogger } from '../../lib/logger'
import type { ItemRef } from '../engine/corrupt-item-tracker'
import { itemRefKey } from '../engine/sync-context'
import type { PackFileHandle } from './pack-file-reader'

const log = createLogger('RecordPacks')

/** A pull item rebuilt from a record pack entry, at the cursor of the write it holds. */
export interface PackedRecord {
  item: RecordPullItemResponse
  sortKey: number
}

/** A manifest item the packs do not hold, at the cursor the manifest lists it. */
export type PullByIdRef = ItemRef & { serverCursor?: number }

/**
 * The record half of a fresh-device pack bootstrap, reconciled against the
 * manifest (protocol 08 §8.10, **Closing checks**). The pull applies `apply`,
 * pulls `pullById`, and only then starts its tail at `tailStart`.
 */
export interface PackedRecords {
  apply: PackedRecord[]
  pullById: PullByIdRef[]
  tailStart: number
  /** Notes whose body the packs brought to the body manifest's head (§8.10, Bodies). */
  settledBodies: ReadonlySet<string>
}

export interface RecordManifestRead {
  items: RecordSyncManifest['items']
  complete: boolean
}

const recordTypes: ReadonlySet<string> = new Set(RECORD_SYNC_ITEM_TYPES)
const decoder = new TextDecoder()

/**
 * Where the record tail may start on pack coverage alone (§8.10, **Where the
 * tail starts**, steps 1 and 2): the unbroken run of held ranged packs from 0,
 * raised to `coveredThrough` when the run reaches `packedThrough`. 0 without a
 * `record` coverage statement.
 */
export const recordCoverageEnd = (
  packs: readonly PackSummary[],
  coverage: PackCoverage | undefined
): number => {
  if (!coverage) return 0
  const ranged = packs
    .filter((pack) => pack.coverFrom !== undefined && pack.coverThrough !== undefined)
    .toSorted((a, b) => a.coverFrom! - b.coverFrom!)
  let end = 0
  for (const pack of ranged) {
    if (pack.coverFrom! > end) break
    end = Math.max(end, pack.coverThrough!)
  }
  return end >= coverage.packedThrough ? Math.max(end, coverage.coveredThrough) : end
}

/**
 * Every record entry of the held packs rebuilt as a pull item (§8.4.2).
 * `unusable` holds the `sortKey` of each entry that could not be rebuilt; an
 * entry of a type this build does not declare is skipped and exempt.
 */
export const readRecordEntries = async (
  handles: readonly PackFileHandle[],
  onBytes: (byteCount: number) => void
): Promise<{ records: PackedRecord[]; unusable: number[] }> => {
  const records: PackedRecord[] = []
  const unusable: number[] = []
  for (const handle of handles) {
    for (const entry of handle.entries) {
      if (entry.kind !== 'record') continue
      // At the FIRST ':': a folder_config id is a path and may hold one.
      const split = entry.id.indexOf(':')
      const type = split > 0 ? entry.id.slice(0, split) : ''
      if (split > 0 && !recordTypes.has(type)) continue
      const meta = RecordPackEntryMetaSchema.safeParse(entry.meta)
      let item: RecordPullItemResponse | null = null
      if (split > 0 && meta.success) {
        try {
          const bytes = await handle.readEntry(entry)
          onBytes(bytes.byteLength)
          const blob: unknown = JSON.parse(decoder.decode(bytes))
          const parsed = RecordPullItemResponseSchema.safeParse({
            ...meta.data,
            id: entry.id.slice(split + 1),
            type,
            blob
          })
          if (parsed.success) item = parsed.data
        } catch (error) {
          log.debug('Record pack entry unreadable — it stays item-granular', {
            sortKey: entry.sortKey,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
      if (item) records.push({ item, sortKey: entry.sortKey })
      else unusable.push(entry.sortKey)
    }
  }
  return { records, unusable }
}

const isTombstone = (item: RecordPullItemResponse): boolean =>
  item.operation === 'delete' || item.deletedAt !== undefined

/**
 * The cursor-exact reconcile (§8.10, **Closing checks**). Per item, only the
 * newest packed entry counts, as the feed serves a row at its current cursor
 * only.
 *
 * 1. A live entry applies only at the manifest's `serverCursor`. Every
 *    manifest item held at no matching cursor, or listed with no
 *    `serverCursor`, is pulled by id, unless its cursor lies above
 *    `tailStart`, where the tail serves it.
 * 2. A live entry the manifest does not list is not applied: it was deleted.
 * 3. A tombstone applies, unless the manifest lists the item again: then the
 *    re-create is pulled by id and the older tombstone is not needed.
 */
export const reconcileRecords = (
  records: readonly PackedRecord[],
  manifest: RecordSyncManifest['items'],
  tailStart: number
): { apply: PackedRecord[]; pullById: PullByIdRef[] } => {
  const newest = new Map<string, PackedRecord>()
  for (const record of records) {
    const key = itemRefKey(record.item.type, record.item.id)
    const held = newest.get(key)
    if (!held || record.sortKey > held.sortKey) newest.set(key, record)
  }
  // A row updated mid-walk is listed again at its later cursor; keep that one.
  const listed = new Map<string, RecordSyncManifest['items'][number]>()
  for (const item of manifest) {
    const key = itemRefKey(item.type, item.id)
    const seen = listed.get(key)
    if (!seen || (item.serverCursor ?? -1) > (seen.serverCursor ?? -1)) listed.set(key, item)
  }

  const apply: PackedRecord[] = []
  const current = new Set<string>()
  for (const [key, record] of newest) {
    const row = listed.get(key)
    if (isTombstone(record.item)) {
      if (!row) apply.push(record)
    } else if (row?.serverCursor !== undefined && row.serverCursor === record.sortKey) {
      apply.push(record)
      current.add(key)
    }
  }
  const pullById: PullByIdRef[] = []
  for (const [key, row] of listed) {
    if (current.has(key)) continue
    const { id, type, serverCursor } = row
    if (serverCursor !== undefined && serverCursor > tailStart) continue
    pullById.push(serverCursor === undefined ? { id, type } : { id, type, serverCursor })
  }
  return { apply: apply.toSorted((a, b) => a.sortKey - b.sortKey), pullById }
}

/**
 * Record packs as a pull plan, or null when they cannot shorten the pull: no
 * coverage reaches past 0, or the manifest read failed or stopped short. A
 * manifest that stopped short cannot tell a deleted record from an unread
 * one, so the packs are not trusted and the pull runs from cursor 0.
 */
export const planRecordPacks = async (
  held: ReadonlyArray<{ pack: PackSummary; handle: PackFileHandle }>,
  coverage: PackCoverage | undefined,
  readManifest: () => Promise<RecordManifestRead | null>,
  onBytes: (byteCount: number) => void
): Promise<Omit<PackedRecords, 'settledBodies'> | null> => {
  const reach = recordCoverageEnd(
    held.map(({ pack }) => pack),
    coverage
  )
  if (reach === 0) return null
  // Read after the pack bytes are held (§8.4.2, Manifest reconcile).
  const read = await readManifest()
  if (!read?.complete) {
    log.info('Record manifest unavailable — record packs unused, the pull runs from 0')
    return null
  }
  const manifest: RecordSyncManifest['items'] = []
  for (const raw of read.items) {
    const parsed = RecordSyncManifestItemSchema.safeParse(raw)
    if (!parsed.success) {
      log.info('Record manifest item failed validation — record packs unused')
      return null
    }
    manifest.push(parsed.data)
  }
  const { records, unusable } = await readRecordEntries(
    held.map(({ handle }) => handle),
    onBytes
  )
  // §8.4.2, Record tail: at most sortKey - 1 of every unusable entry.
  let tailStart = reach
  for (const sortKey of unusable) tailStart = Math.min(tailStart, Math.max(0, sortKey - 1))
  const { apply, pullById } = reconcileRecords(records, manifest, tailStart)
  log.info('Record packs reconciled', {
    entries: records.length,
    unusable: unusable.length,
    apply: apply.length,
    pullById: pullById.length,
    reach,
    tailStart
  })
  return { apply, pullById, tailStart }
}
