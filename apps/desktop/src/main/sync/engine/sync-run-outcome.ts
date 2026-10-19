import type {
  GetSyncStatusResult,
  SyncNowBlockedReason,
  TriggerSyncResult
} from '@memry/contracts/ipc-sync-ops'
import { trackMainEvent } from '../../telemetry/track'
import { syncErrorTelemetryFor } from '../sync-error-telemetry'
import type { SyncRunOutcome, SyncSkipReason } from './sync-context'

export const DELIVERED: SyncRunOutcome = { status: 'delivered' }
export const INCOMPLETE: SyncRunOutcome = { status: 'incomplete' }

export function skipped(reason: SyncSkipReason): SyncRunOutcome {
  return { status: 'skipped', reason }
}

type SyncRunKind = 'push' | 'pull' | 'full'

const COMPLETED_ACTIONS = {
  push: 'push_completed',
  pull: 'pull_completed',
  full: 'full_completed'
} as const satisfies Record<SyncRunKind, string>

const FAILED_ACTIONS = {
  push: 'push_failed',
  pull: 'pull_failed',
  full: 'full_failed'
} as const satisfies Record<SyncRunKind, string>

/**
 * Records a run that returned. Only a delivered run is a success (#3382): a
 * paused device used to record every refused run as one, hundreds a day with
 * nothing sent.
 */
export function trackSyncRun(
  kind: SyncRunKind,
  outcome: SyncRunOutcome,
  metrics: { durationMs: number; queueCount: number; itemCount?: number }
): void {
  trackMainEvent('sync_run_completed', {
    surface: 'sync',
    action: COMPLETED_ACTIONS[kind],
    result:
      outcome.status === 'delivered'
        ? 'success'
        : outcome.status === 'skipped'
          ? 'skipped'
          : 'failed',
    metrics,
    source: kind,
    // One dimension per event. A skipped run moved nothing, so its reason
    // takes the transport's place.
    dimensions:
      outcome.status === 'skipped' ? { skip_reason: outcome.reason } : { transport: 'record' }
  })
}

/** Records a run that threw. */
export function trackSyncRunFailure(kind: SyncRunKind, error: unknown, durationMs: number): void {
  trackMainEvent('sync_error', {
    surface: 'sync',
    action: FAILED_ACTIONS[kind],
    result: 'failed',
    ...syncErrorTelemetryFor(error),
    metrics: { durationMs },
    source: kind,
    dimensions: { transport: 'record' }
  })
}

const SKIP_REASONS: Record<SyncSkipReason, SyncNowBlockedReason> = {
  paused: 'paused',
  busy: 'busy',
  cancelled: 'unavailable',
  no_credentials: 'signed_out'
}

/** What Sync Now tells the user about the full sync it ran. */
export function syncNowResult(
  outcome: SyncRunOutcome,
  status: GetSyncStatusResult
): TriggerSyncResult {
  if (outcome.status === 'delivered') return { success: true }
  if (outcome.status === 'skipped') return { success: false, reason: SKIP_REASONS[outcome.reason] }
  if (status.status === 'paused' || status.status === 'offline') {
    return { success: false, reason: status.status }
  }
  return { success: false, reason: 'failed', ...(status.error ? { error: status.error } : {}) }
}
