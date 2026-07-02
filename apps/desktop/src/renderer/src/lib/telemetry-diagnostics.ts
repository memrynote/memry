import type { TelemetryResult } from '@memry/contracts/telemetry-api'
import { buildErrorDetail } from '@memry/contracts/telemetry-api'

import { trackTelemetry } from './telemetry'

type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error'

const SAFE_TOKEN = /^(?!.*@)(?!.*:\/\/)(?!.*[/\\]).{1,64}$/

const toSafeToken = (value: unknown, fallback: string): string => {
  const raw =
    value instanceof Error
      ? value.name
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : ''
  const token = raw.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64)
  return SAFE_TOKEN.test(token) ? token : fallback
}

const toErrorCode = (error: unknown): string => {
  if (error instanceof Error && error.name) {
    return toSafeToken(error.name, 'Error')
  }
  if (error && typeof error === 'object' && error.constructor?.name) {
    return toSafeToken(error.constructor.name, 'UnknownError')
  }
  if (typeof error === 'string') return 'StringError'
  return 'UnknownError'
}

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

export const registerRendererDiagnostics = (): void => {
  window.addEventListener('error', (event) => {
    trackRendererError('window_error', event.error ?? event.message)
  })

  window.addEventListener('unhandledrejection', (event) => {
    trackRendererError('unhandled_rejection', event.reason)
  })
}
