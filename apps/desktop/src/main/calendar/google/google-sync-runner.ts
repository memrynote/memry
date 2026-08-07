import { powerMonitor } from 'electron'
import { toSafeToken } from '@memry/contracts/telemetry-api'
import { createLogger } from '../../lib/logger'
import { requireDatabase, isDatabaseInitialized } from '../../database'
import { trackMainError } from '../../telemetry/diagnostics'
import { shouldEmitThrottled } from '../../telemetry/throttle'
import { trackMainEvent } from '../../telemetry/track'
import { isMemryUserSignedIn } from '../../sync/auth-state'
import { hasGoogleCalendarConnection } from './oauth'
import { listCalendarSources } from '../repositories/calendar-sources-repository'
import { getGooglePushRuntime, getOrInitGooglePushRuntime } from './push-runtime'
import { syncGoogleCalendarNow } from './sync-service'

const log = createLogger('Calendar:GoogleSyncRunner')

const RUN_INTERVAL_MS = 5 * 60 * 1000
export const PUSH_BACKOFF_INTERVAL_MS = 30 * 60 * 1000
const TRIGGER_COOLDOWN_MS = 10 * 1000
// Window focus fires on every alt-tab, so the 10 s cooldown let an all-day user
// drive ~6 full calendar syncs a minute (network + DB writes + telemetry). The
// periodic poll above still bounds staleness on its own schedule, and manual
// refresh calls syncGoogleCalendarNow directly, so focus only has to close the
// gap between polls — not race them.
const FOCUS_TRIGGER_COOLDOWN_MS = 2 * 60 * 1000
// Exported so the focus handler in main/index.ts can pass this instead of its own
// literal — a silent rename there would drop focus back to the 10 s cooldown.
export const WINDOW_FOCUS_REASON = 'window-focus'

let syncInterval: NodeJS.Timeout | null = null
let currentPollIntervalMs = RUN_INTERVAL_MS
let resumeHandler: (() => void) | null = null
let lastTriggerAt = 0

export function getCurrentPollIntervalMs(): number {
  return currentPollIntervalMs
}

// A broken fleet re-fails every poll (5–30 min); throttle per action so the
// failure still surfaces in Error Tracking without flooding the queue.
const SYNC_FAILED_THROTTLE_MS = 30 * 60 * 1000
const SYNC_COMPLETED_THROTTLE_MS = 60 * 60 * 1000

function trackSyncFailed(action: string, error: unknown): void {
  if (!shouldEmitThrottled(`calendar_google_sync_failed:${action}`, SYNC_FAILED_THROTTLE_MS)) return
  trackMainError('calendar', action, error)
}

function trackSyncCompleted(source: string): void {
  // Manual refresh emits from the REFRESH_PROVIDER handler; these background
  // sources make sync health measurable. Periodic runs constantly — hourly is
  // enough for cadence dashboards.
  if (
    source === 'periodic' &&
    !shouldEmitThrottled('calendar_google_sync_completed:periodic', SYNC_COMPLETED_THROTTLE_MS)
  ) {
    return
  }
  trackMainEvent('calendar_google_sync_completed', {
    surface: 'calendar',
    action: 'sync_completed',
    source,
    result: 'success'
  })
}

function runPeriodicSync(): void {
  void syncGoogleCalendarNow()
    .then(() => trackSyncCompleted('periodic'))
    .catch((error) => {
      log.warn('periodic Google Calendar sync failed', error)
      trackSyncFailed('google_periodic_sync', error)
    })
}

export function triggerGoogleCalendarSyncNow(reason: string): void {
  if (!isDatabaseInitialized()) {
    log.debug('skipping Google Calendar sync trigger (no vault open)', { reason })
    return
  }
  const now = Date.now()
  const cooldownMs =
    reason === WINDOW_FOCUS_REASON ? FOCUS_TRIGGER_COOLDOWN_MS : TRIGGER_COOLDOWN_MS
  if (now - lastTriggerAt < cooldownMs) {
    log.debug('skipping Google Calendar sync trigger (cooldown)', { reason })
    return
  }
  lastTriggerAt = now
  void syncGoogleCalendarNow()
    .then(() => trackSyncCompleted(toSafeToken(reason, 'trigger')))
    .catch((error) => {
      log.warn('on-demand Google Calendar sync failed', { reason, error })
      trackSyncFailed('google_trigger_sync', error)
    })
}

export function __resetTriggerForTests(): void {
  lastTriggerAt = 0
}

export function reEvaluatePollCadence(activeChannelCount: number): void {
  const target = activeChannelCount > 0 ? PUSH_BACKOFF_INTERVAL_MS : RUN_INTERVAL_MS
  if (target === currentPollIntervalMs) return
  currentPollIntervalMs = target
  if (!syncInterval) return
  clearInterval(syncInterval)
  syncInterval = setInterval(runPeriodicSync, target)
}

export async function startGoogleCalendarSyncRunner(): Promise<void> {
  if (syncInterval) return
  if (!(await isMemryUserSignedIn())) return
  if (!(await hasGoogleCalendarConnection(requireDatabase()))) return

  void syncGoogleCalendarNow()
    .then(() => trackSyncCompleted('initial'))
    .catch((error) => {
      log.warn('initial Google Calendar sync failed', error)
      trackSyncFailed('google_initial_sync', error)
    })

  syncInterval = setInterval(runPeriodicSync, currentPollIntervalMs)

  resumeHandler = () => triggerGoogleCalendarSyncNow('system-resume')
  powerMonitor.on('resume', resumeHandler)

  const pushRuntime = getOrInitGooglePushRuntime({
    onActiveCountChange: (count) => reEvaluatePollCadence(count)
  })
  if (pushRuntime) {
    const db = requireDatabase()
    const sources = listCalendarSources(db, {
      provider: 'google',
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
  }
}

export function stopGoogleCalendarSyncRunner(): void {
  if (resumeHandler) {
    powerMonitor.removeListener('resume', resumeHandler)
    resumeHandler = null
  }

  if (!syncInterval) return
  clearInterval(syncInterval)
  syncInterval = null

  const pushRuntime = getGooglePushRuntime()
  if (pushRuntime) {
    void pushRuntime.stopAll().catch((err) => {
      log.warn('stopAll failed', err)
    })
  }
}
