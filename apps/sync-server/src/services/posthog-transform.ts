import type { TelemetryBatch, TelemetryEvent } from '@memry/contracts/telemetry-api'

import type { PostHogEvent } from './posthog'

// Pure transform: today's anonymous-by-design TelemetryBatch → PostHog-native
// events. Kept free of I/O so the golden tests can pin every mapping. The live
// route and any future tooling MUST import this module rather than reimplement it.

export interface TransformContext {
  installHash: string
  accountId?: string
  environment: string
}

export const resolveDistinctId = (ctx: TransformContext): string =>
  ctx.accountId && ctx.accountId.length > 0 ? ctx.accountId : ctx.installHash

export const personProperties = (
  batch: TelemetryBatch,
  environment: string
): Record<string, unknown> => ({
  platform: batch.platform,
  arch: batch.arch,
  locale: batch.locale,
  app_version: batch.appVersion,
  build_channel: batch.buildChannel,
  sync_state: batch.syncState,
  timezone_offset_minutes: batch.timezoneOffsetMinutes,
  environment
})

// Emitted once per session by the caller (see the KV guard in the route), not on
// every batch: $identify is idempotent in PostHog but bills as an identified event.
// The merge it performs is PERMANENT and cannot be undone.
export const identifyEvent = (
  batch: TelemetryBatch,
  ctx: TransformContext
): PostHogEvent | null => {
  if (!ctx.accountId || ctx.accountId.length === 0) return null
  return {
    event: '$identify',
    distinct_id: ctx.accountId,
    properties: {
      $anon_distinct_id: ctx.installHash,
      $set: personProperties(batch, ctx.environment),
      environment: ctx.environment
    }
  }
}

// page_viewed is the one rename: $pageview unlocks path analysis and the native
// web-analytics views. Every other name is preserved so existing dashboards and
// the 50-event contract stay legible.
const EVENT_NAME_OVERRIDES: Record<string, string> = {
  page_viewed: '$pageview'
}

const METRIC_KEYS = [
  ['durationMs', 'duration_ms'],
  ['itemCount', 'item_count'],
  ['byteCount', 'byte_count'],
  ['queueCount', 'queue_count'],
  ['resultCount', 'result_count'],
  ['retryCount', 'retry_count'],
  ['activeSeconds', 'active_seconds'],
  ['value', 'value']
] as const

export const productEvent = (
  batch: TelemetryBatch,
  event: TelemetryEvent,
  ctx: TransformContext
): PostHogEvent => {
  const properties: Record<string, unknown> = {
    surface: event.surface,
    action: event.action,
    environment: ctx.environment,
    session_id: batch.sessionId,
    $set: personProperties(batch, ctx.environment)
  }

  if (event.objectType) properties.object_type = event.objectType
  if (event.source) properties.source = event.source
  if (event.result) properties.result = event.result
  if (event.errorCode) properties.error_code = event.errorCode

  for (const [from, to] of METRIC_KEYS) {
    const value = event.metrics?.[from]
    if (typeof value === 'number') properties[to] = value
  }

  // The contract permits at most one dimension; flatten it so it is filterable
  // like any other property instead of nesting an object.
  if (event.dimensions) {
    for (const [key, value] of Object.entries(event.dimensions)) properties[key] = value
  }

  return {
    event: EVENT_NAME_OVERRIDES[event.name] ?? event.name,
    distinct_id: resolveDistinctId(ctx),
    properties,
    timestamp: event.occurredAt
  }
}
