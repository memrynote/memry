import type { RecordPullItemResponse } from '@memry/contracts/sync-api'

import { createLogger } from '../../lib/logger'
import type { ItemApplier } from '../apply-item'
import type { DrizzleDb } from '../item-handlers'
import type { PackedRecords } from '../packs/record-packs'
import type { ItemRef } from './corrupt-item-tracker'
import { removeUnlistedPackRow } from './unlisted-pack-row'
import type { PullRunState } from './pull-run-state'
import { itemRefKey, PULL_REQUEST_MAX_IDS, SYNC_STATE_KEYS } from './sync-context'
import type { SyncStateManager } from './sync-state-manager'

const log = createLogger('PackedRecordApply')

/**
 * The `type:id` keys a fresh device's record-pack phase applied, or was about
 * to apply, while `LAST_CURSOR` is unset (#5390, protocol 08 §8.10, Closing
 * checks rule 2). Written before the first slice; the state manager deletes it
 * in the transaction that first writes `LAST_CURSOR`. Absent on a device with
 * a cursor, so a stale row an older build left behind is never read.
 */
export function readPackApplied(state: SyncStateManager): Set<string> | undefined {
  if (state.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) != null) return undefined
  const raw = state.getStateValue(SYNC_STATE_KEYS.RECORD_PACKS_APPLIED)
  if (raw === undefined) return new Set()
  try {
    const keys: unknown = JSON.parse(raw)
    if (Array.isArray(keys)) return new Set(keys.filter((key) => typeof key === 'string'))
  } catch {
    // Falls through to the log below.
  }
  // Unreadable: treat no row as pack-only, which keeps every local row.
  log.warn('Record-pack applied set unreadable — no row is removed by the manifest')
  return new Set()
}

/** The pull's own apply path, as the record packs use it. */
export interface PackedRecordApplyDeps {
  /** Applies one slice through the page path with no cursor move; true when it stopped on a cursor-holding problem. */
  applySlice: (
    inline: RecordPullItemResponse[],
    cursorOf: (id: string) => number
  ) => Promise<boolean>
  /** Pulls and applies `refs` by id; false when the fetch stopped short. */
  pullById: (refs: readonly ItemRef[]) => Promise<boolean>
  setCursor: (cursor: string) => void
  /** Durably records the pack phase's `type:id` keys, before any of them applies. */
  recordApplied: (keys: ReadonlySet<string>) => void
  /** §8.10 rule 2 for one key the manifest omits; true when no live local row is left. */
  removeUnlisted: (key: string) => boolean
}

/** The durable half of the deps: the cursor and the pack phase's record (#5390). */
export const packDeps = (
  state: SyncStateManager,
  db: DrizzleDb,
  applier: ItemApplier
): Pick<PackedRecordApplyDeps, 'setCursor' | 'recordApplied' | 'removeUnlisted'> => ({
  setCursor: (cursor) => state.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, cursor),
  recordApplied: (keys) =>
    state.setStateValue(SYNC_STATE_KEYS.RECORD_PACKS_APPLIED, JSON.stringify([...keys])),
  removeUnlisted: (key) => removeUnlistedPackRow(db, applier, key)
})

/**
 * Whether the pull skips a purged-tombstone marker for `ref` because the run
 * started from cursor 0 (#2302): a fresh device has nothing to delete, except
 * a row an interrupted record-pack phase applied (#5390, §8.10 rule 2).
 */
export const skipsMarker = (runState: PullRunState, ref: ItemRef): boolean =>
  runState.fromZero === true && !runState.packApplied?.has(itemRefKey(ref.type, ref.id))

/**
 * A fresh device's record packs (protocol 08 §8.10, Closing checks): apply
 * the reconciled entries, pull by id every manifest item they do not hold,
 * and only then set LAST_CURSOR to the tail start. That order is the
 * data-loss line: a cursor set first and a crash before the by-id pull would
 * skip those items for good, since the tail never answers below its cursor.
 * Until the cursor is set a crash redoes all of it, and every row that
 * already landed comes back equal-clock and skips.
 *
 * 'tail' when the cursor is set or the run falls back to the feed from 0,
 * 'refused' when a slice stopped on a key problem that holds the cursor.
 */
export async function applyPackedRecords(
  runState: PullRunState,
  packed: PackedRecords,
  deps: PackedRecordApplyDeps
): Promise<'tail' | 'refused'> {
  // The lowest cursor per id: ids repeat across types, and ranking a row
  // below its own cursor can only lower the tail start, never skip a row.
  const cursorOf = new Map<string, number>()
  for (const { item, sortKey } of packed.apply) {
    cursorOf.set(item.id, Math.min(sortKey, cursorOf.get(item.id) ?? sortKey))
  }
  // §8.10 rule 2 (#5390): an earlier run of this phase may have applied rows
  // the manifest no longer lists, deleted since and maybe shed to a marker the
  // tail never serves. Then the set is recorded, before the first slice, so a
  // crash anywhere after it leaves every row this phase applies on record.
  const recorded = new Set<string>()
  for (const key of runState.packApplied ?? []) {
    if (packed.listed.has(key) || !deps.removeUnlisted(key)) recorded.add(key)
  }
  for (const { item } of packed.apply) {
    if (item.operation !== 'delete' && item.deletedAt === undefined) {
      recorded.add(itemRefKey(item.type, item.id))
    }
  }
  for (const ref of packed.pullById) recorded.add(itemRefKey(ref.type, ref.id))
  deps.recordApplied(recorded)
  runState.packApplied = recorded
  // The tail after the packs sends no body headers: body kinds state no coverage.
  runState.fromZero = true
  // Bodies the packs brought to the manifest head need no pull (#5390).
  runState.bodySettled = packed.settledBodies
  try {
    for (let i = 0; i < packed.apply.length; i += PULL_REQUEST_MAX_IDS) {
      if (runState.signal.aborted) return 'tail'
      const inline = packed.apply.slice(i, i + PULL_REQUEST_MAX_IDS).map(({ item }) => item)
      if (await deps.applySlice(inline, (id) => cursorOf.get(id) ?? 0)) return 'refused'
    }
    if (!(await deps.pullById(packed.pullById)) || runState.signal.aborted) return 'tail'
  } finally {
    runState.bodySettled = undefined
  }
  // §8.4.2, Record tail: an entry that did not apply is served again.
  let tailStart = packed.tailStart
  for (const { item, sortKey } of packed.apply) {
    if (!runState.applied.covers(item, sortKey)) tailStart = Math.min(tailStart, sortKey - 1)
  }
  // The by-id pull reports a failed request, a cooldown or a vanished row as
  // done: an item it did not apply is left to the tail, below its cursor.
  for (const ref of packed.pullById) {
    if (!runState.applied.covers(ref, 0)) {
      tailStart = Math.min(tailStart, (ref.serverCursor ?? 1) - 1)
    }
  }
  deps.setCursor(String(Math.max(0, tailStart)))
  log.info('Pull: record packs applied', {
    applied: packed.apply.length,
    pulledById: packed.pullById.length,
    tailStart
  })
  return 'tail'
}
