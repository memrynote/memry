import type {
  TelemetryAuthState,
  TelemetryBatch,
  TelemetryBuildChannel,
  TelemetryEvent,
  TelemetryPlatform,
  TelemetrySyncState
} from '@memry/contracts/telemetry-api'
import {
  sanitizeTelemetryDimensions,
  sanitizeTelemetryFailure
} from '@memry/contracts/telemetry-api'

import { createLogger } from '../lib/logger'
import { createQueueStore } from './queue-store'

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
  /** Resolves the signed-in account's access token for identity attribution; null/throw → anonymous batch. */
  getAccessToken?: () => Promise<string | null>
  /**
   * Absolute path of the crash-durable mirror. `app_crashed` (and every other
   * event recorded in the ≤30s before a hard crash) lives in THIS queue, so
   * without it the crash marker only reports a crash that does not kill the app
   * again within one flush interval. Omitted → memory only, as before.
   */
  persistPath?: string
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
  const store = deps.persistPath ? createQueueStore<TelemetryEvent>(deps.persistPath) : null
  // Restore only when telemetry is on: an install that opted out between
  // launches must not keep the previous session's events on disk, let alone
  // ship them. Each restored event keeps its own occurredAt; the batch envelope
  // is stamped with the CURRENT session, so a resurrected event is attributed
  // to the launch that shipped it rather than the one that died.
  const queue: TelemetryEvent[] = store && deps.initialEnabled ? store.load() : []
  if (store && !deps.initialEnabled) store.clear()
  let enabled = deps.initialEnabled

  const trimQueue = (): void => {
    if (queue.length > TELEMETRY_QUEUE_LIMIT) {
      queue.splice(0, queue.length - TELEMETRY_QUEUE_LIMIT)
    }
  }

  const persist = (): void => {
    store?.save(queue)
  }

  // The enqueue path appends one line rather than rewriting the mirror, so a
  // tracked event costs the same whether the queue holds 1 event or 500.
  const persistAppend = (event: TelemetryEvent): void => {
    store?.append(event, queue)
  }

  // A mirror written by a build with a larger limit must not resurrect an
  // unbounded queue; rewrite so the dropped head does not return next launch.
  if (queue.length > TELEMETRY_QUEUE_LIMIT) {
    trimQueue()
    persist()
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

  // The single chokepoint every event passes on its way to the queue file and
  // then off the device: trackMainEvent, the renderer's IPC handler, the
  // bootstrap events in runtime.ts and the direct runtime.track callers all end
  // up here. Enforcing the dimension allowlist at this one point is what makes
  // it structurally impossible for a new call site to ship free text as a
  // dimension — no producer can opt out by not calling a helper (#1142).
  const track = (event: TelemetryEvent): void => {
    if (!enabled) return
    const dimensions = sanitizeTelemetryDimensions(event.dimensions)
    // Same chokepoint, same reason: a failure detail that would fail schema
    // validation must lose its own field, never the whole batch it rides in.
    const failure = sanitizeTelemetryFailure(event.failure)
    const safe =
      dimensions === event.dimensions && failure === event.failure
        ? event
        : { ...event, dimensions, failure }
    queue.push(safe)
    trimQueue()
    persistAppend(safe)
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
      } catch (error) {
        logger.debug('getAccessToken failed, sending anonymous telemetry', {
          error: error instanceof Error ? error.message : String(error)
        })
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
        // A 4xx (except 429 rate limit) means the server permanently rejects this
        // payload — e.g. a validation failure. Keeping it re-sends the same head-of-
        // queue batch every flush, wedging the pipeline behind one bad event. Drop it.
        // 5xx and 429 are transient, so leave those queued for a later retry.
        const permanentlyRejected =
          response.status >= 400 && response.status < 500 && response.status !== 429
        if (permanentlyRejected) {
          queue.splice(0, batchSize)
          persist()
        }
        logger.warn('Telemetry batch rejected', {
          status: response.status,
          reason,
          dropped: permanentlyRejected
        })
        return {
          success: false,
          attempted: batchSize,
          accepted: 0,
          error: `HTTP ${response.status}`
        }
      }

      queue.splice(0, batchSize)
      persist()
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
      // Turning telemetry off must leave nothing behind on disk either.
      store?.clear()
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
