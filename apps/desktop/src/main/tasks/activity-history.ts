/**
 * Task activity log — the read side.
 *
 * Exists as its own feature module because the IPC layer may import neither a
 * `database/queries/*` module nor anything under `sync/` (see
 * scripts/check-architecture-boundaries.js), and answering this query needs
 * both: the rows, and this device's id to resolve `isThisDevice`.
 *
 * @module tasks/activity-history
 */

import type { TaskActivityListInput, TaskActivityListResponse } from '@memry/contracts/tasks-api'
import { requireDatabase } from '../database'
import { listTaskActivity, pruneTaskActivity } from '../database/queries/task-activity'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import { taskActivityRetentionCutoff } from '@memry/sync-client/task-activity-retention'
import { createLogger } from '../lib/logger'

const log = createLogger('TaskActivityHistory')

/** At most one prune sweep per hour per process. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000
let lastPruneAt = 0

export function getTaskActivity(input: TaskActivityListInput): TaskActivityListResponse {
  // Prune on read, the same way note snapshots prune on write. Retention has to
  // actually run somewhere: `applyUpsert` rejecting rows past the cutoff only
  // converges because every device eventually deletes its own, and a device
  // that never pruned would keep showing entries its peers have already
  // dropped — and can no longer accept back.
  maybePruneExpiredTaskActivity()

  const db = requireDatabase()
  return listTaskActivity(db, input, getCurrentDeviceId(db))
}

export function maybePruneExpiredTaskActivity(now: number = Date.now()): number {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return 0
  lastPruneAt = now
  return pruneExpiredTaskActivity()
}

/**
 * Enforces retention locally. Safe to call repeatedly: every device applies the
 * same age rule, and `task-activity-handler.applyUpsert` rejects rows past the
 * cutoff, so a pruned row cannot be resurrected by a peer that still holds it.
 */
export function pruneExpiredTaskActivity(): number {
  try {
    const removed = pruneTaskActivity(requireDatabase(), taskActivityRetentionCutoff())
    if (removed > 0) log.info('Pruned expired task activity rows', { removed })
    return removed
  } catch (err) {
    log.warn('Failed to prune task activity', { error: err })
    return 0
  }
}

/** Test hook — the interval guard is process-global. */
export function resetTaskActivityPruneGuard(): void {
  lastPruneAt = 0
}
