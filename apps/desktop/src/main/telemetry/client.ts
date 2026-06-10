import type {
  TelemetryAuthState,
  TelemetryBatch,
  TelemetryBuildChannel,
  TelemetryEvent,
  TelemetryPlatform,
  TelemetrySyncState
} from '@memry/contracts/telemetry-api'

import { createLogger } from '../lib/logger'

const logger = createLogger('Telemetry')

export const TELEMETRY_QUEUE_LIMIT = 500
export const TELEMETRY_BATCH_LIMIT = 50

export interface TelemetryClientContext {
  installId: string
  sessionId: string
  appVersion: string
  buildChannel: TelemetryBuildChannel
  platform: TelemetryPlatform
  arch: string
  locale: string
  timezoneOffsetMinutes: number
}

export type TelemetryFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<{ ok: boolean; status: number }>

export interface TelemetryClientDeps {
  fetch: TelemetryFetch
  endpoint: string
  context: TelemetryClientContext
  initialEnabled: boolean
  getAuthState: () => TelemetryAuthState
  getSyncState: () => TelemetrySyncState
  getAccessToken?: () => Promise<string | null>
}

export type TelemetryFlushReason = 'manual' | 'interval' | 'shutdown' | 'background'

export interface TelemetryFlushResult {
  success: boolean
  attempted: number
  accepted: number
  error?: string
}

export interface TelemetryClient {
  track(event: TelemetryEvent): void
  flush(reason: TelemetryFlushReason): Promise<TelemetryFlushResult>
  setEnabled(enabled: boolean): void
  getSettings(): { enabled: boolean }
  getQueueDepth(): number
}

export const createTelemetryClient = (deps: TelemetryClientDeps): TelemetryClient => {
  const queue: TelemetryEvent[] = []
  let enabled = deps.initialEnabled

  const trimQueue = (): void => {
    if (queue.length > TELEMETRY_QUEUE_LIMIT) {
      queue.splice(0, queue.length - TELEMETRY_QUEUE_LIMIT)
    }
  }

  const buildBatch = (events: TelemetryEvent[]): TelemetryBatch => ({
    schemaVersion: 1,
    installId: deps.context.installId,
    sessionId: deps.context.sessionId,
    appVersion: deps.context.appVersion,
    buildChannel: deps.context.buildChannel,
    platform: deps.context.platform,
    arch: deps.context.arch,
    locale: deps.context.locale,
    timezoneOffsetMinutes: deps.context.timezoneOffsetMinutes,
    authState: deps.getAuthState(),
    syncState: deps.getSyncState(),
    clientQueueDepth: queue.length,
    events
  })

  const track = (event: TelemetryEvent): void => {
    if (!enabled) return
    queue.push(event)
    trimQueue()
  }

  const flush = async (reason: TelemetryFlushReason): Promise<TelemetryFlushResult> => {
    if (!enabled || queue.length === 0) {
      return { success: true, attempted: 0, accepted: 0 }
    }

    const batchSize = Math.min(queue.length, TELEMETRY_BATCH_LIMIT)
    const events = queue.slice(0, batchSize)
    const batch = buildBatch(events)

    let bearerValue: string | null = null
    if (deps.getAccessToken) {
      try {
        bearerValue = await deps.getAccessToken()
      } catch {
        bearerValue = null
      }
    }

    try {
      const response = await deps.fetch(deps.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(bearerValue ? { Authorization: `Bearer ${bearerValue}` } : {})
        },
        body: JSON.stringify(batch)
      })

      if (!response.ok) {
        logger.warn('Telemetry batch rejected', { status: response.status, reason })
        return {
          success: false,
          attempted: batchSize,
          accepted: 0,
          error: `HTTP ${response.status}`
        }
      }

      queue.splice(0, batchSize)
      return { success: true, attempted: batchSize, accepted: batchSize }
    } catch (error) {
      logger.warn('Telemetry flush failed', {
        reason,
        error: error instanceof Error ? error.message : String(error)
      })
      return {
        success: false,
        attempted: batchSize,
        accepted: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  const setEnabled = (next: boolean): void => {
    enabled = next
    if (!next) {
      queue.length = 0
    }
  }

  return {
    track,
    flush,
    setEnabled,
    getSettings: () => ({ enabled }),
    getQueueDepth: () => queue.length
  }
}
