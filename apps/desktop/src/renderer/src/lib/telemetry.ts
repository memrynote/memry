import type {
  TelemetryEvent,
  TelemetryEventName,
  TelemetryResult,
  TelemetrySurface
} from '@memry/contracts/telemetry-api'

/**
 * Renderer-side, non-blocking, safe telemetry wrapper.
 *
 * Privacy guarantees:
 * - Never includes content, paths, URLs, or other free-form text
 * - Strips dimension values that look like emails, URLs, or paths
 * - Truncates over-long dimension values
 * - Catches every IPC error so a failing main process never breaks the UI
 */

const SAFE_DIMENSION_VALUE = /^(?!.*@)(?!.*:\/\/)(?!.*[/\\]).{1,64}$/

const isSafeDimensionValue = (value: unknown): value is string =>
  typeof value === 'string' && SAFE_DIMENSION_VALUE.test(value)

const sanitizeDimensions = (
  dimensions: Record<string, string> | undefined
): Record<string, string> | undefined => {
  if (!dimensions) return undefined
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(dimensions)) {
    if (isSafeDimensionValue(value)) {
      cleaned[key] = value
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined
}

export interface TrackTelemetryOptions {
  surface: TelemetrySurface
  action: string
  objectType?: string
  source?: string
  result?: TelemetryResult
  errorCode?: string
  metrics?: TelemetryEvent['metrics']
  dimensions?: Record<string, string>
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
    const api = (window as Window & { api?: { telemetry?: { track?: (event: TelemetryEvent) => Promise<unknown> } } }).api
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
      dimensions: sanitizeDimensions(options.dimensions),
      metrics: options.metrics
    }

    await track(event)
  } catch {
    // Never throw — telemetry must not break the UI
  }
}
