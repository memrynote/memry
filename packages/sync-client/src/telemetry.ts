import type { TelemetryEvent, TelemetryEventName, TelemetryResult, TelemetrySurface, TelemetryErrorDetail } from '@memry/contracts/telemetry-api'

/**
 * Engine-internal telemetry facade, mirroring desktop's `trackMainEvent` /
 * `trackMainLog` surface so extracted modules keep their call sites
 * unchanged. The shell injects the real sink once at startup via
 * `setSyncClientTelemetrySink`; desktop's sink forwards into its existing
 * telemetry runtime (which owns buffering, redaction and throttling), so
 * events emitted while unwired are dropped here, not queued — wire early.
 */
export interface SyncTelemetryEventOptions {
  surface: TelemetrySurface
  action: string
  objectType?: string
  source?: string
  result?: TelemetryResult
  errorCode?: string
  metrics?: {
    durationMs?: number
    itemCount?: number
    byteCount?: number
    queueCount?: number
    resultCount?: number
    retryCount?: number
    activeSeconds?: number
    value?: number
  }
  dimensions?: Record<string, string>
  error?: TelemetryEvent['error']
  /** Bounded HTTP status / server code / retryable for a failed request. */
  failure?: TelemetryEvent['failure']
}

export type SyncDiagnosticLevel = 'debug' | 'info' | 'warn' | 'error'

export interface SyncTelemetryLogOptions {
  scope: string
  action: string
  errorCode?: string
  error?: TelemetryErrorDetail
  metrics?: {
    durationMs?: number
    itemCount?: number
    byteCount?: number
    queueCount?: number
    retryCount?: number
    value?: number
  }
}

export interface SyncTelemetrySink {
  trackEvent(name: TelemetryEventName, options: SyncTelemetryEventOptions): void
  trackLog(level: SyncDiagnosticLevel, options: SyncTelemetryLogOptions): void
}

let sink: SyncTelemetrySink | null = null

export function setSyncClientTelemetrySink(s: SyncTelemetrySink | null): void {
  sink = s
}

export const trackMainEvent = (
  name: TelemetryEventName,
  options: SyncTelemetryEventOptions
): void => {
  sink?.trackEvent(name, options)
}

export const trackMainLog = (level: SyncDiagnosticLevel, options: SyncTelemetryLogOptions): void => {
  sink?.trackLog(level, options)
}
