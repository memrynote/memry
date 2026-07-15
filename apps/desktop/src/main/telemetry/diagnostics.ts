import type { TelemetryResult } from '@memry/contracts/telemetry-api'
import {
  buildErrorDetail,
  normalizeRejectionReason,
  toErrorCode,
  toSafeToken
} from '@memry/contracts/telemetry-api'

import { isExpectedConditionError } from './expected-conditions'
import { trackMainEvent, type TrackMainEventOptions } from './track'

type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error'

const resultForLevel = (level: DiagnosticLevel): TelemetryResult =>
  level === 'error' || level === 'warn' ? 'failed' : 'success'

// Utility workers (embeddings, image-processing, voice-model) idle-shutdown
// cleanly after ~30s; a clean exit is lifecycle, not a fault, so it must not
// become an error event. Real faults get a composite code that stays inside
// the safe-token rules (no '@', '://', '/', '\', ≤64 chars).
export const childProcessGoneErrorCode = (details: {
  type: string
  reason: string
  serviceName?: string
}): string | null => {
  if (details.reason === 'clean-exit') return null
  return toSafeToken(
    `${details.type}:${details.reason}:${details.serviceName ?? ''}`,
    'ChildProcessGone'
  )
}

// Reports a `child-process-gone` fault as an error log event, or nothing at all
// for a clean idle-worker exit. Kept here (not inline in index.ts) so the
// skip decision is unit-tested rather than living in the untested bootstrap.
export const trackChildProcessGone = (details: {
  type: string
  reason: string
  serviceName?: string
}): void => {
  const errorCode = childProcessGoneErrorCode(details)
  if (!errorCode) return
  trackMainLog('error', { scope: 'Electron', action: 'child_process_gone', errorCode })
}

export const trackMainError = (source: string, action: string, error: unknown): void => {
  // Expected conditions (Ollama not running, an abandoned OAuth flow) still
  // reach the UI as an error envelope, but they are normal states — reporting
  // them here drowns the real signal.
  if (isExpectedConditionError(error)) return

  trackMainEvent('app_error_seen', {
    surface: 'app',
    action: toSafeToken(action, 'error'),
    objectType: 'exception',
    source: toSafeToken(source, 'main_process'),
    result: 'failed',
    errorCode: toErrorCode(error),
    error: buildErrorDetail(error)
  })
}

// A rejection reason can be any value — a string, a plain object, or a
// cross-realm Error that fails `instanceof Error` — and those carry no stack,
// landing in telemetry as an unactionable bare `Error` with an empty stack.
// Normalizing first guarantees a stack and a code naming the reason's type.
// Kept here (not inline in index.ts) so it is unit-tested rather than living in
// the untested bootstrap.
export const trackMainUnhandledRejection = (reason: unknown): void => {
  trackMainError('main_process', 'unhandled_rejection', normalizeRejectionReason(reason))
}

export const trackMainLog = (
  level: DiagnosticLevel,
  options: {
    scope: string
    action: string
    errorCode?: string
    metrics?: { durationMs?: number; itemCount?: number; queueCount?: number; retryCount?: number }
  }
): void => {
  const eventOptions: TrackMainEventOptions = {
    surface: 'app',
    action: level,
    objectType: 'log',
    source: toSafeToken(options.scope, 'main_process'),
    result: resultForLevel(level),
    dimensions: { log_action: toSafeToken(options.action, 'event') }
  }

  if (options.errorCode) {
    eventOptions.errorCode = toSafeToken(options.errorCode, 'LogError')
  }
  if (options.metrics) {
    eventOptions.metrics = options.metrics
  }

  trackMainEvent('app_log_recorded', eventOptions)
}

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

export const startActiveHeartbeat = (isFocused: () => boolean): void => {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    if (!isFocused()) return
    trackMainEvent('app_active_heartbeat', {
      surface: 'app',
      action: 'heartbeat',
      metrics: { activeSeconds: HEARTBEAT_INTERVAL_MS / 1000 }
    })
  }, HEARTBEAT_INTERVAL_MS)
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref()
  }
}

export const stopActiveHeartbeat = (): void => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

export const trackLaunchPhase = (phase: string, durationMs: number): void => {
  trackMainEvent('app_launch_phase_completed', {
    surface: 'app',
    action: toSafeToken(phase, 'phase'),
    source: 'main_process',
    result: 'success',
    metrics: { durationMs: Math.max(0, Math.round(durationMs)) }
  })
}
