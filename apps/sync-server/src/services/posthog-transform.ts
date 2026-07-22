import type { TelemetryBatch } from '@memry/contracts/telemetry-api'

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
