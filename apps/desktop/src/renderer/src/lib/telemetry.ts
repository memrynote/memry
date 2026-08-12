import type {
  TelemetryEvent,
  TelemetryEventName,
  TelemetryResult,
  TelemetrySurface
} from '@memry/contracts/telemetry-api'
import { sanitizeTelemetryDimensions } from '@memry/contracts/telemetry-api'

/**
 * Renderer-side, non-blocking, safe telemetry wrapper.
 *
 * Privacy guarantees:
 * - Never includes content, paths, URLs, or other free-form text
 * - Keeps only allowlisted dimension keys carrying bounded, enumerable values
 * - Catches every IPC error so a failing main process never breaks the UI
 */

// Shared with the main process rather than re-derived here: the key allowlist is
// the whole guarantee, and two copies of it would drift (#1142).

export interface TrackTelemetryOptions {
  surface: TelemetrySurface
  action: string
  objectType?: string
  source?: string
  result?: TelemetryResult
  errorCode?: string
  metrics?: TelemetryEvent['metrics']
  dimensions?: Record<string, string>
  error?: TelemetryEvent['error']
}

const generateEventId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback (should not normally hit; jsdom provides crypto.randomUUID)
  const random = (length: number): string =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `${random(8)}-${random(4)}-${random(4)}-${random(4)}-${random(12)}`
}

export const trackTelemetry = async (
  name: TelemetryEventName,
  options: TrackTelemetryOptions
): Promise<void> => {
  try {
    const api = (
      window as Window & {
        api?: { telemetry?: { track?: (event: TelemetryEvent) => Promise<unknown> } }
      }
    ).api
    const track = api?.telemetry?.track
    if (typeof track !== 'function') return

    const event: TelemetryEvent = {
      id: generateEventId(),
      name,
      occurredAt: new Date().toISOString(),
      surface: options.surface,
      action: options.action,
      objectType: options.objectType,
      source: options.source,
      result: options.result,
      errorCode: options.errorCode,
      dimensions: sanitizeTelemetryDimensions(options.dimensions),
      metrics: options.metrics,
      error: options.error
    }

    await track(event)
  } catch {
    // Never throw — telemetry must not break the UI
  }
}
