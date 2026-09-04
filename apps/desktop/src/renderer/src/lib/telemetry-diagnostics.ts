import type { TelemetryResult } from '@memry/contracts/telemetry-api'
import {
  buildErrorDetail,
  normalizeRejectionReason,
  normalizeWindowError,
  toErrorCode,
  toSafeToken
} from '@memry/contracts/telemetry-api'

import { trackTelemetry } from './telemetry'

type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error'

const resultForLevel = (level: DiagnosticLevel): TelemetryResult =>
  level === 'error' || level === 'warn' ? 'failed' : 'success'

export const trackRendererError = (
  action: string,
  error: unknown,
  componentStack?: string
): void => {
  void trackTelemetry('app_error_seen', {
    surface: 'app',
    action: toSafeToken(action, 'error'),
    objectType: 'exception',
    source: 'renderer',
    result: 'failed',
    errorCode: toErrorCode(error),
    error: buildErrorDetail(error, componentStack)
  })
}

export const trackRendererLog = (
  level: DiagnosticLevel,
  action: string,
  scope = 'renderer'
): void => {
  void trackTelemetry('app_log_recorded', {
    surface: 'app',
    action: level,
    objectType: 'log',
    source: toSafeToken(scope, 'renderer'),
    result: resultForLevel(level),
    dimensions: { log_action: toSafeToken(action, 'event') }
  })
}

export const trackRendererReady = (durationMs: number): void => {
  void trackTelemetry('app_launch_phase_completed', {
    surface: 'app',
    action: 'renderer_ready',
    source: 'renderer',
    result: 'success',
    metrics: { durationMs: Math.max(0, Math.round(durationMs)) }
  })
}

export const trackNoteReadable = (durationMs: number): void => {
  void trackTelemetry('app_launch_phase_completed', {
    surface: 'app',
    action: 'note_readable',
    source: 'renderer',
    result: 'success',
    metrics: { durationMs: Math.max(0, Math.round(durationMs)) }
  })
}

export const registerRendererDiagnostics = (): void => {
  window.addEventListener('error', (event) => {
    // `event.error` is absent for cross-origin scripts and some Chromium failure
    // paths; passing the bare message string on landed in telemetry as
    // `StringError` with no stack. Normalize so a class name and the source
    // location always survive.
    trackRendererError(
      'window_error',
      normalizeWindowError({
        error: event.error,
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      })
    )
  })

  window.addEventListener('unhandledrejection', (event) => {
    // A rejection reason can be any value, and a non-Error reason carries no
    // stack — those landed in telemetry as an unactionable `Error` with an
    // empty stack. Normalize first so a code + stack always survive.
    trackRendererError('unhandled_rejection', normalizeRejectionReason(event.reason))
  })
}
