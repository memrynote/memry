import type {
  TelemetryEvent,
  TelemetryEventName,
  TelemetryResult,
  TelemetrySurface
} from '@memry/contracts/telemetry-api'

import { createLogger } from '../lib/logger'
import { getTelemetryRuntime } from './runtime'

const logger = createLogger('Telemetry')

// Failures BEFORE the telemetry runtime initializes (app-identity migration,
// Safe Storage carry-over, early bootstrap) used to vanish: trackMainEvent
// no-opped while the runtime was null. Buffer them instead, and drain once the
// runtime installs. Null after draining — a disposed runtime during shutdown
// must not quietly re-accumulate events nobody will ever flush.
const EARLY_BUFFER_LIMIT = 100
let earlyBuffer: TelemetryEvent[] | null = []

export interface TrackMainEventOptions {
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
}

/**
 * Main-process safe wrapper for emitting a telemetry event. Never throws and
 * silently no-ops if the runtime has not been initialized.
 */
export const trackMainEvent = (name: TelemetryEventName, options: TrackMainEventOptions): void => {
  try {
    const event: TelemetryEvent = {
      id: crypto.randomUUID(),
      name,
      occurredAt: new Date().toISOString(),
      surface: options.surface,
      action: options.action,
      objectType: options.objectType,
      source: options.source,
      result: options.result,
      errorCode: options.errorCode,
      metrics: options.metrics,
      dimensions: options.dimensions,
      error: options.error
    }
    const runtime = getTelemetryRuntime()
    if (!runtime) {
      if (earlyBuffer && earlyBuffer.length < EARLY_BUFFER_LIMIT) {
        earlyBuffer.push(event)
      }
      return
    }
    runtime.track(event)
  } catch (error) {
    logger.warn('Failed to emit telemetry event', { name, error })
  }
}

/**
 * Forward events buffered before the runtime existed. Called once from main
 * startup right after initializeTelemetryRuntime; original occurredAt
 * timestamps are preserved.
 */
export const drainEarlyMainEvents = (): void => {
  try {
    const runtime = getTelemetryRuntime()
    if (!runtime || !earlyBuffer) return
    const buffered = earlyBuffer
    earlyBuffer = null
    for (const event of buffered) {
      runtime.track(event)
    }
  } catch (error) {
    logger.warn('Failed to drain early telemetry events', { error })
  }
}
