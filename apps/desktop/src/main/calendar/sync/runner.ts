import { powerMonitor } from 'electron'
import { toSafeToken, type TelemetryEventName } from '@memry/contracts/telemetry-api'
import { createLogger } from '../../lib/logger'
import { isDatabaseInitialized } from '../../database'
import { trackMainError } from '../../telemetry/diagnostics'
import { shouldEmitThrottled } from '../../telemetry/throttle'
import { trackMainEvent } from '../../telemetry/track'
import { isMemryUserSignedIn } from '../../sync/auth-state'
import { ProviderRateLimitError } from '../provider/errors'
import type { ProviderCapabilities } from '../provider/adapter'

const log = createLogger('Calendar:SyncRunner')

const RUN_INTERVAL_MS = 5 * 60 * 1000
export const PUSH_BACKOFF_INTERVAL_MS = 30 * 60 * 1000
const TRIGGER_COOLDOWN_MS = 10 * 1000
// Window focus fires on every alt-tab, so the 10 s cooldown let an all-day user
// drive ~6 full calendar syncs a minute (network + DB writes + telemetry). The
// periodic poll above still bounds staleness on its own schedule, and manual
// refresh calls the sync directly, so focus only has to close the gap between
// polls — not race them.
const FOCUS_TRIGGER_COOLDOWN_MS = 2 * 60 * 1000
// Exported so the focus handler in main/index.ts can pass this instead of its own
// literal — a silent rename there would drop focus back to the 10 s cooldown.
export const WINDOW_FOCUS_REASON = 'window-focus'

/**
 * Everything the scheduler needs from one provider. Push-capable providers
 * supply the two push hooks; providers with `supportsPush: false` leave them
 * out and simply keep the polling cadence.
 */
export interface ProviderRunnerContext {
  providerId: string
  capabilities: ProviderCapabilities
  /** Pull everything this provider has, now. */
  syncNow(): Promise<void>
  /** The provider has at least one account with usable local credentials. */
  hasConnection(): Promise<boolean>
  /** Telemetry names, still per-provider until the multi-provider pass (#1406). */
  telemetry: {
    syncCompletedEvent: TelemetryEventName
    syncFailedPrefix: string
  }
  startPushRuntime?(input: { onActiveCountChange: (count: number) => void }): void
  stopPushRuntime?(): void
}

interface RunnerState {
  syncInterval: NodeJS.Timeout | null
  currentPollIntervalMs: number
  resumeHandler: (() => void) | null
  lastTriggerAt: number
  startInFlight: Promise<void> | null
  startGeneration: number
  /**
   * Epoch ms before which this provider must not be polled again, set from a
   * `ProviderRateLimitError`'s own `retryAfterMs` hint. Hammering a provider
   * that just asked us to back off is how an account gets throttled harder.
   */
  rateLimitedUntil: number
}

/**
 * One scheduler per provider. This used to be a single set of module globals,
 * so a second provider would have shared — and clobbered — Google's timer,
 * resume listener and cooldown.
 */
const runners = new Map<string, RunnerState>()

function getState(providerId: string): RunnerState {
  const existing = runners.get(providerId)
  if (existing) return existing
  const fresh: RunnerState = {
    syncInterval: null,
    currentPollIntervalMs: RUN_INTERVAL_MS,
    resumeHandler: null,
    lastTriggerAt: 0,
    startInFlight: null,
    startGeneration: 0,
    rateLimitedUntil: 0
  }
  runners.set(providerId, fresh)
  return fresh
}

export function getCurrentPollIntervalMs(providerId: string): number {
  return getState(providerId).currentPollIntervalMs
}

// A broken fleet re-fails every poll (5–30 min); throttle per action so the
// failure still surfaces in Error Tracking without flooding the queue.
const SYNC_FAILED_THROTTLE_MS = 30 * 60 * 1000
const SYNC_COMPLETED_THROTTLE_MS = 60 * 60 * 1000

function trackSyncFailed(context: ProviderRunnerContext, action: string, error: unknown): void {
  const key = `${context.telemetry.syncFailedPrefix}:${action}`
  if (!shouldEmitThrottled(key, SYNC_FAILED_THROTTLE_MS)) return
  trackMainError('calendar', action, error)
}

function trackSyncCompleted(context: ProviderRunnerContext, source: string): void {
  // Manual refresh emits from the REFRESH_PROVIDER handler; these background
  // sources make sync health measurable. Periodic runs constantly — hourly is
  // enough for cadence dashboards.
  if (
    source === 'periodic' &&
    !shouldEmitThrottled(
      `${context.telemetry.syncCompletedEvent}:periodic`,
      SYNC_COMPLETED_THROTTLE_MS
    )
  ) {
    return
  }
  trackMainEvent(context.telemetry.syncCompletedEvent, {
    surface: 'calendar',
    action: 'sync_completed',
    source,
    result: 'success'
  })
}

/**
 * Honour a provider's own back-off hint. Returns true when the error was a
 * rate limit and the next poll has been pushed out accordingly.
 */
function applyRateLimitBackoff(
  state: RunnerState,
  context: ProviderRunnerContext,
  error: unknown
): boolean {
  if (!(error instanceof ProviderRateLimitError)) return false
  const waitMs = error.retryAfterMs ?? state.currentPollIntervalMs
  state.rateLimitedUntil = Date.now() + waitMs
  log.warn('calendar provider asked us to back off', {
    provider: context.providerId,
    waitMs
  })
  return true
}

/** Epoch ms before which this provider must not be polled. 0 = not throttled. */
export function getRateLimitedUntil(providerId: string): number {
  return getState(providerId).rateLimitedUntil
}

function runPeriodicSync(context: ProviderRunnerContext): void {
  const state = getState(context.providerId)
  if (Date.now() < state.rateLimitedUntil) {
    log.debug('skipping periodic calendar sync (rate limited)', {
      provider: context.providerId,
      until: state.rateLimitedUntil
    })
    return
  }
  void context
    .syncNow()
    .then(() => trackSyncCompleted(context, 'periodic'))
    .catch((error) => {
      if (applyRateLimitBackoff(state, context, error)) return
      log.warn('periodic calendar sync failed', { provider: context.providerId, error })
      trackSyncFailed(context, `${context.providerId}_periodic_sync`, error)
    })
}

export function triggerProviderSyncNow(context: ProviderRunnerContext, reason: string): void {
  if (!isDatabaseInitialized()) {
    log.debug('skipping calendar sync trigger (no vault open)', {
      provider: context.providerId,
      reason
    })
    return
  }
  const state = getState(context.providerId)
  const now = Date.now()
  const cooldownMs =
    reason === WINDOW_FOCUS_REASON ? FOCUS_TRIGGER_COOLDOWN_MS : TRIGGER_COOLDOWN_MS
  if (now - state.lastTriggerAt < cooldownMs) {
    log.debug('skipping calendar sync trigger (cooldown)', {
      provider: context.providerId,
      reason
    })
    return
  }
  if (now < state.rateLimitedUntil) {
    log.debug('skipping calendar sync trigger (rate limited)', {
      provider: context.providerId,
      reason
    })
    return
  }
  state.lastTriggerAt = now
  void context
    .syncNow()
    .then(() => trackSyncCompleted(context, toSafeToken(reason, 'trigger')))
    .catch((error) => {
      if (applyRateLimitBackoff(state, context, error)) return
      log.warn('on-demand calendar sync failed', { provider: context.providerId, reason, error })
      trackSyncFailed(context, `${context.providerId}_trigger_sync`, error)
    })
}

export function __resetTriggerForTests(providerId: string): void {
  const state = getState(providerId)
  state.lastTriggerAt = 0
  state.rateLimitedUntil = 0
}

/**
 * Push-capable providers back off the poll while their channels are live.
 * A provider with `supportsPush: false` never reaches this — it has no
 * channels to count, so it stays on the plain polling cadence.
 */
export function reEvaluatePollCadence(
  context: ProviderRunnerContext,
  activeChannelCount: number
): void {
  const state = getState(context.providerId)
  const target =
    context.capabilities.supportsPush && activeChannelCount > 0
      ? PUSH_BACKOFF_INTERVAL_MS
      : RUN_INTERVAL_MS
  if (target === state.currentPollIntervalMs) return
  state.currentPollIntervalMs = target
  if (!state.syncInterval) return
  clearInterval(state.syncInterval)
  state.syncInterval = setInterval(() => runPeriodicSync(context), target)
}

// Startup, sign-in, connect-account and device registration can all call this
// within the same session. The `syncInterval` guard alone is not enough: it is
// checked before the awaits below, so two overlapping callers both pass it and
// the second setInterval orphans the first — unreachable by stop() and by quit.
// The in-flight latch is assigned synchronously, so the second caller joins the
// first instead of arming a duplicate timer and resume listener.
export async function startProviderSyncRunner(context: ProviderRunnerContext): Promise<void> {
  const state = getState(context.providerId)
  if (state.syncInterval) return
  if (state.startInFlight) {
    await state.startInFlight
    return
  }
  state.startInFlight = runStart(context, state)
  try {
    await state.startInFlight
  } finally {
    state.startInFlight = null
  }
}

async function runStart(context: ProviderRunnerContext, state: RunnerState): Promise<void> {
  const generation = state.startGeneration
  if (!(await isMemryUserSignedIn())) return
  if (!(await context.hasConnection())) return
  // Sign-out / disconnect can call stop() while this start is still parked on
  // the awaits above. Installing now would arm a timer and resume listener that
  // nothing is going to stop again. Checked after the last await, before any
  // install.
  if (generation !== state.startGeneration) return

  void context
    .syncNow()
    .then(() => trackSyncCompleted(context, 'initial'))
    .catch((error) => {
      if (applyRateLimitBackoff(state, context, error)) return
      log.warn('initial calendar sync failed', { provider: context.providerId, error })
      trackSyncFailed(context, `${context.providerId}_initial_sync`, error)
    })

  state.syncInterval = setInterval(() => runPeriodicSync(context), state.currentPollIntervalMs)

  state.resumeHandler = () => triggerProviderSyncNow(context, 'system-resume')
  powerMonitor.on('resume', state.resumeHandler)

  if (context.capabilities.supportsPush && context.startPushRuntime) {
    context.startPushRuntime({
      onActiveCountChange: (count) => reEvaluatePollCadence(context, count)
    })
  }
}

export function stopProviderSyncRunner(context: ProviderRunnerContext): void {
  const state = getState(context.providerId)
  // Bump first, above the `!syncInterval` early return: when the runner has not
  // installed its interval yet, an in-flight start is exactly what needs
  // invalidating.
  state.startGeneration += 1

  if (state.resumeHandler) {
    powerMonitor.removeListener('resume', state.resumeHandler)
    state.resumeHandler = null
  }

  if (!state.syncInterval) return
  clearInterval(state.syncInterval)
  state.syncInterval = null

  context.stopPushRuntime?.()
}
