import { setSetting } from '../database/queries/settings'
import type { DataDb } from '../database/types'
import { syncSettingsFieldUpdate } from '../settings/runtime-effects'
import { READWISE_SETTINGS_KEY, readReadwiseGroup } from './settings'
import { getLastRun } from './sync-state'

/**
 * The run status other devices read (#1408 D18): `status.lastChangeAt` (ISO) and
 * `status.error` (an error code, or `null`) in the synced `readwise` group, one
 * field clock per leaf. The pulling device writes a leaf only when a run changed
 * something or the error state changed, so an unchanged hourly run sends
 * nothing. A cleared error is an explicit `null`, never a removed key (§13.4).
 */
export function publishRunStatus(db: DataDb, run: { changed: boolean; now: Date }): void {
  const group = readReadwiseGroup(db)
  const stored =
    typeof group.status === 'object' && group.status !== null && !Array.isArray(group.status)
      ? (group.status as Record<string, unknown>)
      : {}
  const lastRun = getLastRun(db)
  const error = lastRun?.needsAttention ? (lastRun.attention ?? 'invalid-token') : null
  const errorChanged = (typeof stored.error === 'string' ? stored.error : null) !== error
  if (!run.changed && !errorChanged) return

  const next: Record<string, unknown> = { ...stored }
  const pushes: [string, unknown][] = []
  if (run.changed) {
    next.lastChangeAt = run.now.toISOString()
    pushes.push(['readwise.status.lastChangeAt', next.lastChangeAt])
  }
  if (errorChanged) {
    next.error = error
    pushes.push(['readwise.status.error', error])
  }
  setSetting(db, READWISE_SETTINGS_KEY, JSON.stringify({ ...group, status: next }))
  for (const [path, value] of pushes) syncSettingsFieldUpdate(path, value)
}
