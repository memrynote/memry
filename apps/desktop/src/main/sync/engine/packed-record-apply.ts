import type { RecordPullItemResponse } from '@memry/contracts/sync-api'

import { createLogger } from '../../lib/logger'
import type { PackedRecords } from '../packs/record-packs'
import type { ItemRef } from './corrupt-item-tracker'
import type { PullRunState } from './pull-run-state'
import { PULL_REQUEST_MAX_IDS } from './sync-context'

const log = createLogger('PackedRecordApply')

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
}

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
