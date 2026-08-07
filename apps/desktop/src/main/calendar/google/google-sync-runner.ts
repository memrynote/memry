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

let syncInterval: NodeJS.Timeout | null = null
let currentPollIntervalMs = RUN_INTERVAL_MS
let resumeHandler: (() => void) | null = null
let lastTriggerAt = 0
let startInFlight: Promise<void> | null = null
let startGeneration = 0

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
  if (now - lastTriggerAt < TRIGGER_COOLDOWN_MS) {
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

// Startup, sign-in, connect-account and device registration can all call this
// within the same session. The `syncInterval` guard alone is not enough: it is
// checked before the awaits below, so two overlapping callers both pass it and
// the second setInterval orphans the first — unreachable by stop() and by quit.
// The in-flight latch is assigned synchronously, so the second caller joins the
// first instead of arming a duplicate timer and resume listener.
export async function startGoogleCalendarSyncRunner(): Promise<void> {
  if (syncInterval) return
  if (startInFlight) {
    await startInFlight
    return
  }
  startInFlight = runStart()
  try {
    await startInFlight
  } finally {
    startInFlight = null
  }
}

async function runStart(): Promise<void> {
  const generation = startGeneration
  if (!(await isMemryUserSignedIn())) return
  if (!(await hasGoogleCalendarConnection(requireDatabase()))) return
  // Sign-out / disconnect can call stop() while this start is still parked on
  // the awaits above. Installing now would arm a timer and resume listener that
  // nothing is going to stop again. Checked after the last await, before any
  // install.
  if (generation !== startGeneration) return

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
  // Bump first, above the `!syncInterval` early return: when the runner has not
  // installed its interval yet, an in-flight start is exactly what needs
  // invalidating.
  startGeneration += 1

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
