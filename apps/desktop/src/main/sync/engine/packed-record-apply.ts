import type { RecordPullItemResponse } from '@memry/contracts/sync-api'

import { createLogger } from '../../lib/logger'
import type { DrizzleDb } from '../item-handlers'
import type { PackedRecords } from '../packs/record-packs'
import type { ItemRef } from './corrupt-item-tracker'
import { pullsUnlistedRow } from './pack-row-modified'
import { readUnresolved, writeUnresolved } from './pack-unresolved'
import type { PurgedTombstone } from './pull-envelope'
import type { PullRunState } from './pull-run-state'
import { itemRefKey, PULL_REQUEST_MAX_IDS, SYNC_STATE_KEYS } from './sync-context'
import type { SyncStateManager } from './sync-state-manager'

const log = createLogger('PackedRecordApply')

/**
 * The rows a fresh device's record-pack phase applied, or was about to apply,
 * each with the cursor of the write it holds (#5390, protocol 08 §8.10,
 * Closing checks rule 2). Written before the first slice; deleted by the pull
 * only after rule 2 ran over it and LAST_CURSOR moved past 0. While it exists,
 * every pull runs rule 2 over it before any page: a run cut short, a rerun
 * with no pack plan, or a cursor reset to 0 would otherwise pull from cursor
 * 0, which never serves a purged-tombstone marker. Undefined when absent.
 */
export function readPackApplied(state: SyncStateManager): Map<string, number> | undefined {
  const raw = state.getStateValue(SYNC_STATE_KEYS.RECORD_PACKS_APPLIED)
  if (raw === undefined) return undefined
  try {
    const held: unknown = JSON.parse(raw)
    if (held && typeof held === 'object' && !Array.isArray(held)) {
      return new Map(
        Object.entries(held).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number'
        )
      )
    }
  } catch {
    // Falls through to the log below.
  }
  // Unreadable: treat no row as pack-only, which keeps every local row.
  log.warn('Record-pack applied set unreadable — no row is removed by the manifest')
  return new Map()
}

/** The pull's own apply path, as the record packs use it. */
export interface PackedRecordApplyDeps {
  /** Applies one slice through the page path with no cursor move; true when it stopped on a cursor-holding problem. */
  applySlice: (
    inline: RecordPullItemResponse[],
    cursorOf: (id: string) => number
  ) => Promise<boolean>
  /** Pulls and applies `refs` by id; false when the fetch stopped short, or with `requireAnswers` left any ref unanswered. */
  pullById: (refs: readonly ItemRef[], opts?: { requireAnswers?: boolean }) => Promise<boolean>
  setCursor: (cursor: string) => void
  /** Durably records the pack phase's rows and held cursors, before any of them applies. */
  recordApplied: (held: ReadonlyMap<string, number>) => void
  /** §8.10 rule 2: whether an unlisted key is pulled by id (a live row not modified here). */
  pullsUnlisted: (key: string) => boolean
  /** Adds the keys rule 2 pulled and kept to the durable unresolved set. */
  recordUnresolved: (keys: readonly string[]) => void
}

/** The durable half of the deps: the cursor and the pack phase's records (#5390). */
export const packDeps = (
  state: SyncStateManager,
  db: DrizzleDb
): Pick<
  PackedRecordApplyDeps,
  'setCursor' | 'recordApplied' | 'pullsUnlisted' | 'recordUnresolved'
> => ({
  setCursor: (cursor) => state.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, cursor),
  recordApplied: (held) =>
    state.setStateValue(
      SYNC_STATE_KEYS.RECORD_PACKS_APPLIED,
      JSON.stringify(Object.fromEntries(held))
    ),
  pullsUnlisted: (key) => pullsUnlistedRow(db, key),
  recordUnresolved: (keys) => {
    if (keys.length === 0) return
    const unresolved = readUnresolved(db)
    for (const key of keys) unresolved.add(key)
    writeUnresolved(db, unresolved)
  }
})

/**
 * §8.10 rule 2: a marker removes a pack-phase row only when its cursor is past
 * the write the row holds; one at or below it is no evidence about that write.
 */
export const markerNotPastHeld = (
  runState: Pick<PullRunState, 'packApplied'>,
  marker: PurgedTombstone
): boolean => {
  const held = runState.packApplied?.get(itemRefKey(marker.type, marker.id))
  return held !== undefined && marker.serverCursor <= held
}

/**
 * Whether the pull skips a purged-tombstone marker: a run from cursor 0 has
 * nothing to delete (#2302), except a row the record-pack phase applied, and
 * that one only on a marker past its held cursor (#5390, §8.10 rule 2).
 */
export const skipsMarker = (runState: PullRunState, marker: PurgedTombstone): boolean =>
  markerNotPastHeld(runState, marker) ||
  (runState.fromZero === true && !runState.packApplied?.has(itemRefKey(marker.type, marker.id)))

/**
 * The record half of a pull: §8.10 rule 2 whenever an earlier pack phase is
 * on record, packs or not, and before any feed page (#5390); the packs while
 * no cursor exists; then the feed. The record goes only once rule 2 ran and
 * the cursor is past 0, where the feed serves every later marker.
 */
export async function pullRecords(
  runState: PullRunState,
  packed: PackedRecords | undefined,
  deps: Pick<PackedRecordApplyDeps, 'applySlice' | 'pullById'> & {
    pullChanges: () => Promise<void>
    state: SyncStateManager
    db: DrizzleDb
  }
): Promise<void> {
  const { state } = deps
  const usesPacks = state.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) == null
  const rule2 = runState.packApplied !== undefined || (packed !== undefined && usesPacks)
  if (rule2) {
    const applyDeps = { ...deps, ...packDeps(state, deps.db) }
    if (
      (await applyPackedRecords(runState, usesPacks ? packed : undefined, applyDeps)) === 'refused'
    ) {
      runState.refused = true
      return
    }
  }
  await deps.pullChanges()
  if (rule2 && Number(state.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)) > 0) {
    state.deleteStateValue(SYNC_STATE_KEYS.RECORD_PACKS_APPLIED)
  }
}

/**
 * A fresh device's record packs (protocol 08 §8.10, Closing checks): rule 2
 * over the rows an earlier pack phase recorded, then apply the reconciled
 * entries, pull by id every manifest item they do not hold, and only then set
 * LAST_CURSOR to the tail start. That order is the data-loss line: a cursor
 * set first and a crash before the by-id pull would skip those items for
 * good, since the tail never answers below its cursor. Until the cursor is set
 * a crash redoes all of it, and every row that already landed comes back
 * equal-clock and skips.
 *
 * With no `packed` (no plan this run, or a cursor already set) only rule 2
 * runs, over every recorded row, since no manifest says which are listed.
 *
 * 'tail' when the pull may go on to the feed, 'refused' when a slice stopped
 * on a key problem that holds the cursor, or when rule 2 or the pack phase
 * stopped short: the feed from cursor 0 never serves the markers rule 2 needs.
 */
export async function applyPackedRecords(
  runState: PullRunState,
  packed: PackedRecords | undefined,
  deps: PackedRecordApplyDeps
): Promise<'tail' | 'refused'> {
  // §8.10 rule 2 (#5390): an earlier run of this phase may have applied rows
  // deleted since and maybe shed to a marker the feed from 0 never serves.
  // Each is pulled by id, below; only a verified delete or an attested marker
  // past its held cursor removes it, and silence keeps it.
  const held = new Map(runState.packApplied ?? [])
  const unlisted: ItemRef[] = []
  for (const key of held.keys()) {
    if (packed?.listed.has(key) || !deps.pullsUnlisted(key)) continue
    const split = key.indexOf(':')
    unlisted.push({ type: key.slice(0, split), id: key.slice(split + 1) })
  }
  if (packed) {
    // Recorded before the first slice, so a crash anywhere after it leaves
    // every row this phase applies on record.
    for (const { item, sortKey } of packed.apply) {
      if (item.operation === 'delete' || item.deletedAt !== undefined) continue
      const key = itemRefKey(item.type, item.id)
      held.set(key, Math.max(sortKey, held.get(key) ?? 0))
    }
    for (const ref of packed.pullById) {
      const key = itemRefKey(ref.type, ref.id)
      held.set(key, Math.max(ref.serverCursor ?? 0, held.get(key) ?? 0))
    }
    deps.recordApplied(held)
  }
  runState.packApplied = held
  // Not part of the tail start: these rows are not in the manifest.
  if (unlisted.length > 0) {
    log.info('Pull: unlisted pack-phase rows pulled by id', { count: unlisted.length })
    // A failed request is no answer, and only an answer may keep a row.
    if (!(await deps.pullById(unlisted, { requireAnswers: true })) || runState.signal.aborted) {
      return 'refused'
    }
    const kept = unlisted
      .filter((ref) => !runState.applied.covers(ref, 0))
      .map((ref) => itemRefKey(ref.type, ref.id))
      .filter((key) => deps.pullsUnlisted(key))
    if (kept.length > 0) {
      log.warn('Pull: unlisted pack-phase rows kept with no delete evidence', {
        count: kept.length
      })
      deps.recordUnresolved(kept)
    }
  }
  if (!packed) return 'tail'
  // The tail after the packs sends no body headers: body kinds state no coverage.
  runState.fromZero = true
  // Bodies the packs brought to the manifest head need no pull (#5390).
  runState.bodySettled = packed.settledBodies
  const cursorOf = cursorsById(packed)
  try {
    for (let i = 0; i < packed.apply.length; i += PULL_REQUEST_MAX_IDS) {
      if (runState.signal.aborted) return 'refused'
      const inline = packed.apply.slice(i, i + PULL_REQUEST_MAX_IDS).map(({ item }) => item)
      if (await deps.applySlice(inline, (id) => cursorOf.get(id) ?? 0)) return 'refused'
    }
    if (!(await deps.pullById(packed.pullById)) || runState.signal.aborted) return 'refused'
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

/** The lowest cursor per id: ids repeat across types, and ranking a row below its own cursor can only lower the tail start, never skip a row. */
const cursorsById = (packed: PackedRecords): Map<string, number> => {
  const cursorOf = new Map<string, number>()
  for (const { item, sortKey } of packed.apply) {
    cursorOf.set(item.id, Math.min(sortKey, cursorOf.get(item.id) ?? sortKey))
  }
  return cursorOf
}
