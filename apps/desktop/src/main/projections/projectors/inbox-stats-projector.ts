import { createLogger } from '../../lib/logger'
import { rebuildInboxStatsTable } from '../../inbox/stats'
import type { ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:InboxStats')

/**
 * Shortest gap allowed between two full `inbox_stats` rebuilds.
 *
 * `rebuildInboxStatsTable()` scans every row of `inbox_items`, rewrites the whole
 * `inbox_stats` table, and there is no cheaper incremental form: a stats row is a
 * per-date aggregate and an `inbox.upserted` event carries only an item id, so
 * adjusting a counter would need the item's previous contribution, which is not
 * stored anywhere. Since one event is published per item, a bookmark import or a
 * sync pull of N items used to cost N full scans plus N table rewrites (#991).
 *
 * Throttling instead of debouncing keeps the common case exact: an isolated
 * capture still rebuilds inline, so nothing reading the stats sees a delay. Only
 * a burst is capped, to one rebuild per window plus a trailing one that folds in
 * everything the window swallowed.
 */
export const INBOX_STATS_REBUILD_INTERVAL_MS = 500

export function createInboxStatsProjector(): ProjectionProjector {
  let lastRebuildAt = 0
  let pendingRebuild: ReturnType<typeof setTimeout> | null = null

  const runRebuild = (): { rows: number } => {
    lastRebuildAt = Date.now()
    return rebuildInboxStatsTable()
  }

  const cancelPendingRebuild = (): void => {
    if (!pendingRebuild) return
    clearTimeout(pendingRebuild)
    pendingRebuild = null
  }

  const runFullRebuild = (): { rows: number } => {
    cancelPendingRebuild()
    return runRebuild()
  }

  return {
    name: 'inbox-stats',

    handles(event: ProjectionEvent): boolean {
      return event.type.startsWith('inbox.')
    },

    async project(): Promise<void> {
      const sinceLastRebuild = Date.now() - lastRebuildAt
      if (sinceLastRebuild >= INBOX_STATS_REBUILD_INTERVAL_MS) {
        cancelPendingRebuild()
        runRebuild()
        return
      }

      if (pendingRebuild) return

      pendingRebuild = setTimeout(() => {
        pendingRebuild = null
        try {
          runRebuild()
        } catch (error) {
          // Outside the runtime's per-event try/catch, so an unguarded throw
          // (closed database after the vault shut down) would surface as an
          // unhandled exception. The next inbox event rebuilds anyway.
          logger.warn('Deferred inbox stats rebuild failed', error)
        }
      }, INBOX_STATS_REBUILD_INTERVAL_MS - sinceLastRebuild)
      pendingRebuild.unref?.()
    },

    async rebuild(): Promise<{ rows: number }> {
      return runFullRebuild()
    },

    async reconcile(): Promise<{ rows: number }> {
      return runFullRebuild()
    }
  }
}
