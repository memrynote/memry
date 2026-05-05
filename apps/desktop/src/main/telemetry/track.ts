import type {
  TelemetryEventName,
  TelemetryResult,
  TelemetrySurface
} from '@memry/contracts/telemetry-api'

import { createLogger } from '../lib/logger'
import { getTelemetryRuntime } from './runtime'

const logger = createLogger('Telemetry')

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
}

/**
 * Main-process safe wrapper for emitting a telemetry event. Never throws and
 * silently no-ops if the runtime has not been initialized.
 */
export const trackMainEvent = (name: TelemetryEventName, options: TrackMainEventOptions): void => {
  try {
    const runtime = getTelemetryRuntime()
    if (!runtime) return
    runtime.track({
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
      dimensions: options.dimensions
    })
  } catch (error) {
    logger.warn('Failed to emit telemetry event', { name, error })
  }
}
