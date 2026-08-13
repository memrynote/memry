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
import { getCurrentDeviceId } from '../sync/current-device-id'
import { taskActivityRetentionCutoff } from '../sync/task-activity-retention'
import { createLogger } from '../lib/logger'

const log = createLogger('TaskActivityHistory')

export function getTaskActivity(input: TaskActivityListInput): TaskActivityListResponse {
  const db = requireDatabase()
  return listTaskActivity(db, input, getCurrentDeviceId(db))
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
