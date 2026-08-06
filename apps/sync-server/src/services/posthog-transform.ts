import type { TelemetryBatch, TelemetryEvent } from '@memry/contracts/telemetry-api'
import { redactText } from '@memry/contracts/redact'

import type { PostHogEvent } from './posthog'

// Pure transform: today's anonymous-by-design TelemetryBatch → PostHog-native
// events. Kept free of I/O so the golden tests can pin every mapping. The live
// route and any future tooling MUST import this module rather than reimplement it.

export interface TransformContext {
  installHash: string
  /**
   * HMAC of the account id (`hashTelemetryId`), NEVER the raw account id.
   * Deliberately named `accountHash`, not `accountId`, for the same reason
   * `installHash` is: PostHog is a third-party sink and only ever sees opaque
   * hashes. See ACCOUNT_HASH_PATTERN below.
   */
  accountHash?: string
  environment: string
}

// THE ONE-WAY DOOR. `hashTelemetryId` returns exactly 64 lowercase hex chars.
// Anything else reaching this field is a bug — most plausibly a raw account id
// — and must never become a `distinct_id`, because a `$identify` merge in
// PostHog is PERMANENT and IRREVERSIBLE: a leaked raw account id cannot be
// un-leaked or re-keyed afterwards. Shape-checking here rather than trusting
// call sites means the failure mode of a future mistake is "telemetry stays
// anonymous", not "raw account ids are now in a third-party product forever".
// Do not relax this to a truthiness check.
const ACCOUNT_HASH_PATTERN = /^[0-9a-f]{64}$/

export const isAccountHash = (value: string | undefined): value is string =>
  typeof value === 'string' && ACCOUNT_HASH_PATTERN.test(value)

export const resolveDistinctId = (ctx: TransformContext): string =>
  isAccountHash(ctx.accountHash) ? ctx.accountHash : ctx.installHash

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

// Emitted once per session by the caller (see claimIdentifySession in the
// route), not on every batch: $identify is idempotent in PostHog but bills as an
// identified event. The merge it performs is PERMANENT and cannot be undone.
export const identifyEvent = (
  batch: TelemetryBatch,
  ctx: TransformContext
): PostHogEvent | null => {
  // Not `resolveDistinctId`: that falls back to installHash, which would make
  // $identify alias the anonymous person onto itself. No valid account hash
  // means no merge at all.
  if (!isAccountHash(ctx.accountHash)) return null
  return {
    event: '$identify',
    distinct_id: ctx.accountHash,
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
  const properties: Record<string, unknown> = {}

  // Client-supplied dimensions MUST be written first. TelemetryDimensionsSchema
  // (packages/contracts/src/telemetry-api.ts) validates dimension VALUES with
  // SAFE_DIMENSION_VALUE but does not allowlist dimension KEYS, so a client can
  // send a dimension named e.g. "environment" or "session_id". Every
  // server-derived assignment below this point must run AFTER this loop so it
  // unconditionally overwrites any colliding key — trusted values must always
  // win over client input. Do not "tidy" this by moving the loop back to the
  // end; that reintroduces a client-spoofable environment/session_id/$set.
  if (event.dimensions) {
    for (const [key, value] of Object.entries(event.dimensions)) properties[key] = value
  }

  properties.surface = event.surface
  properties.action = event.action
  properties.environment = ctx.environment
  properties.session_id = batch.sessionId
  properties.$set = personProperties(batch, ctx.environment)

  // platform / app_version / build_channel are ALSO event properties, not only
  // person properties via $set. Two reasons, both load-bearing:
  //  1. A person property records the LATEST value, so "app version split" built
  //     on $set answers "which version is each install on now", not "which
  //     version emitted this event" — wrong for adoption and regression charts.
  //  2. Dashboards built before this migration break down on the event property
  //     `platform` (e.g. "Installs by Platform"). Emitting only $set would leave
  //     those tiles silently empty after cutover instead of failing loudly.
  properties.platform = batch.platform
  properties.app_version = batch.appVersion
  properties.build_channel = batch.buildChannel

  if (event.objectType) properties.object_type = event.objectType
  if (event.source) properties.source = event.source
  if (event.result) properties.result = event.result
  if (event.errorCode) properties.error_code = event.errorCode

  for (const [from, to] of METRIC_KEYS) {
    const value = event.metrics?.[from]
    if (typeof value === 'number') properties[to] = value
  }

  return {
    event: EVENT_NAME_OVERRIDES[event.name] ?? event.name,
    distinct_id: resolveDistinctId(ctx),
    properties,
    timestamp: event.occurredAt
  }
}

// Error Tracking requires the event name to be exactly `$exception`; a plain
// `exception` lands in Events and never reaches the Error Tracking product.
//
// $exception_fingerprint is set explicitly to our own errorCode. Left unset,
// PostHog derives a hash from the exception pattern — pinning it to errorCode
// reproduces the grouping semantics of the retired "errors by code" panel.
export const exceptionEvent = (
  batch: TelemetryBatch,
  event: TelemetryEvent,
  ctx: TransformContext
): PostHogEvent | null => {
  if (!event.errorCode && !event.error) return null

  // type only needs a label, so falling back to the event name is harmless here.
  const type = event.errorCode ?? event.name
  // Defense in depth: the client already redacted, re-run in mask mode (no hasher).
  const message = event.error?.message ? redactText(event.error.message, {}) : ''
  const stack = event.error?.stack ?? ''
  const value = [message, stack].filter((part) => part.length > 0).join('\n\n') || type

  return {
    event: '$exception',
    distinct_id: resolveDistinctId(ctx),
    properties: {
      $exception_list: [
        {
          type,
          value,
          mechanism: { handled: true, synthetic: false }
        }
      ],
      // Unlike `type`, the fingerprint must NOT fall back to event.name: that would
      // collapse every distinct error without an errorCode into one Error Tracking
      // issue (all grouped under e.g. "app_error_seen"), defeating the pinning this
      // comment block exists to justify. Omit the key when there is no errorCode so
      // PostHog falls back to its own pattern-hash grouping instead. Do not
      // "simplify" this back to an unconditional assignment.
      ...(event.errorCode ? { $exception_fingerprint: event.errorCode } : {}),
      surface: event.surface,
      action: event.action,
      app_version: batch.appVersion,
      build_channel: batch.buildChannel,
      platform: batch.platform,
      environment: ctx.environment
    },
    timestamp: event.occurredAt
  }
}
