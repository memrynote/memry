import { createLogger } from '../../../lib/logger'
import { requireDatabase } from '../../../database'
import { hasGoogleCalendarConnection } from './oauth'
import { listCalendarSources } from '../../repositories/calendar-sources-repository'
import { getGooglePushRuntime, getOrInitGooglePushRuntime } from './push-runtime'
import { syncGoogleCalendarNow } from './sync-service'
import { GOOGLE_CAPABILITIES, GOOGLE_PROVIDER_ID } from './capabilities'
import {
  __resetTriggerForTests as resetTriggerForProvider,
  getCurrentPollIntervalMs as getProviderPollIntervalMs,
  reEvaluatePollCadence as reEvaluateProviderPollCadence,
  startProviderSyncRunner,
  stopProviderSyncRunner,
  triggerProviderSyncNow,
  type ProviderRunnerContext
} from '../../sync/runner'

const log = createLogger('Calendar:GoogleSyncRunner')

export { PUSH_BACKOFF_INTERVAL_MS, WINDOW_FOCUS_REASON } from '../../sync/runner'

/**
 * Google's slot in the generic scheduler. The cadence, the trigger cooldowns
 * and the start/stop latching all live in `calendar/sync/runner.ts`; this only
 * supplies Google's sync entry point and its push-channel runtime.
 */
const googleRunnerContext: ProviderRunnerContext = {
  providerId: GOOGLE_PROVIDER_ID,
  capabilities: GOOGLE_CAPABILITIES,
  syncNow: () => syncGoogleCalendarNow(),
  hasConnection: () => hasGoogleCalendarConnection(requireDatabase()),
  telemetry: {
    syncCompletedEvent: 'calendar_google_sync_completed',
    syncFailedPrefix: 'calendar_google_sync_failed'
  },
  startPushRuntime: ({ onActiveCountChange }) => {
    const pushRuntime = getOrInitGooglePushRuntime({ onActiveCountChange })
    if (!pushRuntime) return
    const sources = listCalendarSources(requireDatabase(), {
      provider: GOOGLE_PROVIDER_ID,
      kind: 'calendar',
      selectedOnly: true
    }).map((s) => ({
      id: s.id,
      remoteId: s.remoteId,
      isMemryManaged: s.isMemryManaged
    }))
    void pushRuntime.ensureForSelectedSources(sources).catch((err) => {
      log.warn('ensureForSelectedSources failed', err)
    })
  },
  stopPushRuntime: () => {
    const pushRuntime = getGooglePushRuntime()
    if (!pushRuntime) return
    void pushRuntime.stopAll().catch((err) => {
      log.warn('stopAll failed', err)
    })
  }
}

export function getCurrentPollIntervalMs(): number {
  return getProviderPollIntervalMs(GOOGLE_PROVIDER_ID)
}

export function triggerGoogleCalendarSyncNow(reason: string): void {
  triggerProviderSyncNow(googleRunnerContext, reason)
}

export function __resetTriggerForTests(): void {
  resetTriggerForProvider(GOOGLE_PROVIDER_ID)
}

export function reEvaluatePollCadence(activeChannelCount: number): void {
  reEvaluateProviderPollCadence(googleRunnerContext, activeChannelCount)
}

export async function startGoogleCalendarSyncRunner(): Promise<void> {
  await startProviderSyncRunner(googleRunnerContext)
}

export function stopGoogleCalendarSyncRunner(): void {
  stopProviderSyncRunner(googleRunnerContext)
}
