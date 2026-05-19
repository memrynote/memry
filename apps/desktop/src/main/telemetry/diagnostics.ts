import type { TelemetryResult } from '@memry/contracts/telemetry-api'

import { trackMainEvent, type TrackMainEventOptions } from './track'

type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error'

const SAFE_TOKEN = /^(?!.*@)(?!.*:\/\/)(?!.*[/\\]).{1,64}$/

const toSafeToken = (value: unknown, fallback: string): string => {
  const raw = value instanceof Error ? value.name : String(value ?? '')
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

export const trackMainError = (source: string, action: string, error: unknown): void => {
  trackMainEvent('app_error_seen', {
    surface: 'app',
    action: toSafeToken(action, 'error'),
    objectType: 'exception',
    source: toSafeToken(source, 'main_process'),
    result: 'failed',
    errorCode: toErrorCode(error)
  })
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

export const trackLaunchPhase = (phase: string, durationMs: number): void => {
  trackMainEvent('app_launch_phase_completed', {
    surface: 'app',
    action: toSafeToken(phase, 'phase'),
    source: 'main_process',
    result: 'success',
    metrics: { durationMs: Math.max(0, Math.round(durationMs)) }
  })
}
