import type { TelemetryBatch, TelemetryEvent } from '@memry/contracts/telemetry-api'
import { redactSensitive } from '@memry/contracts/telemetry-api'

import { AppError, ErrorCodes } from '../lib/errors'
import type { Bindings } from '../types'
import {
  sendPostHogBatch,
  sendPostHogLogs,
  toPostHogExceptionEvent,
  type PostHogBatchPayload,
  type PostHogEventPayload,
  type PostHogLogAttributeValue,
  type PostHogLogLevel,
  type PostHogLogRecordInput,
  type PostHogPropertyValue
} from './posthog'

const TELEMETRY_BLOB_COUNT = 20
const TELEMETRY_DOUBLE_COUNT = 13
const DESKTOP_SERVICE_NAME = 'memry-desktop'
const requireHmacKey = (key: string): string => {
  if (typeof key !== 'string' || key.length === 0) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Telemetry HMAC key is not configured', 500)
  }
  return key
}

export const hashTelemetryId = async (secret: string, id: string): Promise<string> => {
  const keyMaterial = requireHmacKey(secret)
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(id))
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const timezoneBucket = (offsetMinutes: number): string => {
  const hours = Math.round(offsetMinutes / 60)
  return hours >= 0 ? `UTC+${hours}` : `UTC${hours}`
}

const num = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const firstDimension = (
  dimensions: TelemetryEvent['dimensions']
): { key: string; value: string } => {
  if (!dimensions) return { key: '', value: '' }
  const keys = Object.keys(dimensions).sort()
  if (keys.length === 0) return { key: '', value: '' }
  const key = keys[0]
  return { key, value: dimensions[key] ?? '' }
}

const padArray = <T>(arr: T[], length: number, fill: T): T[] => {
  if (arr.length >= length) return arr
  return [...arr, ...Array.from({ length: length - arr.length }, () => fill)]
}

export interface BatchHashes {
  installHash: string
  sessionHash: string
}

export interface TelemetryDataPoint {
  blobs: string[]
  doubles: number[]
  indexes: string[]
}

export const toDataPoint = (
  batch: TelemetryBatch,
  event: TelemetryEvent,
  hashes: BatchHashes
): TelemetryDataPoint => {
  const dim = firstDimension(event.dimensions)

  const blobs: string[] = padArray(
    [
      event.name,
      String(batch.schemaVersion),
      batch.appVersion,
      batch.buildChannel,
      batch.platform,
      batch.arch,
      batch.locale,
      timezoneBucket(batch.timezoneOffsetMinutes),
      batch.authState,
      batch.syncState,
      event.surface,
      event.action,
      event.objectType ?? '',
      event.source ?? '',
      event.result ?? '',
      event.errorCode ?? '',
      dim.key,
      dim.value,
      hashes.sessionHash,
      ''
    ],
    TELEMETRY_BLOB_COUNT,
    ''
  )

  const metrics = event.metrics ?? {}
  const errorCount = event.errorCode ? 1 : 0
  const doubles: number[] = padArray(
    [
      1,
      num(metrics.durationMs),
      num(metrics.itemCount),
      num(metrics.byteCount),
      num(metrics.queueCount),
      num(metrics.resultCount),
      errorCount,
      num(metrics.retryCount),
      num(metrics.activeSeconds),
      num(metrics.value),
      batch.events.length,
      num(batch.clientQueueDepth),
      0
    ],
    TELEMETRY_DOUBLE_COUNT,
    0
  )

  return {
    blobs,
    doubles,
    indexes: [hashes.installHash]
  }
}

export interface TelemetryEnv {
  PRODUCT_TELEMETRY: Bindings['PRODUCT_TELEMETRY']
  TELEMETRY_HMAC_KEY: Bindings['TELEMETRY_HMAC_KEY']
  POSTHOG_API_KEY?: Bindings['POSTHOG_API_KEY']
  POSTHOG_HOST?: Bindings['POSTHOG_HOST']
  ENVIRONMENT?: Bindings['ENVIRONMENT']
}

export interface TelemetryWriteOptions {
  waitUntil?: (promise: Promise<unknown>) => void
  userId?: string
}

const addStringProperty = (
  properties: Record<string, string | number>,
  key: string,
  value: string | undefined
): void => {
  if (typeof value === 'string' && value.length > 0) {
    properties[key] = value
  }
}

const addNumberProperty = (
  properties: Record<string, string | number>,
  key: string,
  value: number | undefined
): void => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    properties[key] = value
  }
}

const safePostHogLabel = (value: string | undefined, fallback: string): string => {
  if (!value) return fallback
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80) || fallback
}

const desktopDistinctId = (
  batch: TelemetryBatch,
  installHash: string,
  environment?: string
): string =>
  `memry_desktop_${safePostHogLabel(environment ?? batch.buildChannel, 'unknown')}_${installHash}`

export const toPostHogEvent = (
  batch: TelemetryBatch,
  event: TelemetryEvent,
  installHash: string,
  environment?: string,
  overrideDistinctId?: string
): PostHogEventPayload => {
  const dim = firstDimension(event.dimensions)
  const metrics = event.metrics ?? {}
  const properties: Record<string, string | number> = {
    app_version: batch.appVersion,
    build_channel: batch.buildChannel,
    platform: batch.platform,
    arch: batch.arch,
    locale: batch.locale,
    timezone_bucket: timezoneBucket(batch.timezoneOffsetMinutes),
    auth_state: batch.authState,
    sync_state: batch.syncState,
    distinct_scope: 'install',
    surface: event.surface,
    action: event.action,
    batch_size: batch.events.length
  }

  addStringProperty(properties, 'environment', environment)
  addStringProperty(properties, 'object_type', event.objectType)
  addStringProperty(properties, 'source', event.source)
  addStringProperty(properties, 'result', event.result)
  addStringProperty(properties, 'error_code', event.errorCode)
  addStringProperty(properties, 'dimension_key', dim.key)
  addStringProperty(properties, 'dimension_value', dim.value)
  addNumberProperty(properties, 'duration_ms', metrics.durationMs)
  addNumberProperty(properties, 'item_count', metrics.itemCount)
  addNumberProperty(properties, 'byte_count', metrics.byteCount)
  addNumberProperty(properties, 'queue_count', metrics.queueCount)
  addNumberProperty(properties, 'result_count', metrics.resultCount)
  addNumberProperty(properties, 'retry_count', metrics.retryCount)
  addNumberProperty(properties, 'active_seconds', metrics.activeSeconds)
  addNumberProperty(properties, 'value', metrics.value)
  addNumberProperty(properties, 'client_queue_depth', batch.clientQueueDepth)

  // Desktop error detail: stack frames + component stack only (never a message —
  // it could contain a note title/content). Re-redact defensively.
  if (event.error?.stack) {
    properties.error_stack = redactSensitive(event.error.stack)
  }
  if (event.error?.componentStack) {
    properties.error_component_stack = redactSensitive(event.error.componentStack)
  }

  return {
    event: event.name,
    distinct_id: overrideDistinctId ?? desktopDistinctId(batch, installHash, environment),
    timestamp: event.occurredAt,
    properties
  }
}

export const toPostHogBatchPayload = (
  apiKey: string,
  batch: TelemetryBatch,
  installHash: string,
  environment?: string,
  overrideDistinctId?: string
): PostHogBatchPayload => ({
  api_key: apiKey,
  batch: batch.events.map((event) =>
    toPostHogEvent(batch, event, installHash, environment, overrideDistinctId)
  )
})

const shouldMirrorTelemetryBatch = (env: TelemetryEnv): boolean =>
  Boolean(env.POSTHOG_API_KEY && env.POSTHOG_HOST)

const getStringProperty = (
  properties: Record<string, PostHogPropertyValue>,
  key: string
): string | undefined => {
  const value = properties[key]
  return typeof value === 'string' ? value : undefined
}

// The full stack / component stack belong on the $exception, not on every log
// line — keep them out of OTLP log attributes to avoid bloating log records.
const HEAVY_LOG_KEYS = new Set(['error_stack', 'error_component_stack'])

const toPrimitiveLogAttributes = (
  event: PostHogEventPayload
): Record<string, PostHogLogAttributeValue> => {
  const attributes: Record<string, PostHogLogAttributeValue> = {
    event_name: event.event
  }

  for (const [key, value] of Object.entries(event.properties)) {
    if (HEAVY_LOG_KEYS.has(key)) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attributes[key] = value
    }
  }

  return attributes
}

const normalizeDesktopLogLevel = (event: PostHogEventPayload): PostHogLogLevel => {
  if (event.event === 'app_error_seen') return 'error'
  const action = getStringProperty(event.properties, 'action')
  if (action === 'debug' || action === 'info' || action === 'warn' || action === 'error') {
    return action
  }
  return 'info'
}

const toDiagnosticBody = (event: PostHogEventPayload): string => {
  const source = getStringProperty(event.properties, 'source') ?? 'desktop'
  const action = getStringProperty(event.properties, 'action') ?? event.event
  const errorCode = getStringProperty(event.properties, 'error_code')
  return [DESKTOP_SERVICE_NAME, source, action, errorCode].filter(Boolean).join(':')
}

const toDesktopLogRecord = (event: PostHogEventPayload): PostHogLogRecordInput | null => {
  if (event.event !== 'app_log_recorded' && event.event !== 'app_error_seen') return null
  return {
    serviceName: DESKTOP_SERVICE_NAME,
    environment: getStringProperty(event.properties, 'environment'),
    distinctId: event.distinct_id,
    timestamp: event.timestamp,
    level: normalizeDesktopLogLevel(event),
    body: toDiagnosticBody(event),
    attributes: toPrimitiveLogAttributes(event)
  }
}

// Desktop actions that originate from global crash handlers are genuinely
// unhandled; everything else (React error boundaries, etc.) was caught.
const UNHANDLED_DESKTOP_ACTIONS = new Set([
  'window_error',
  'unhandled_rejection',
  'uncaught_exception',
  'boot_failed',
  'render_process_gone',
  'child_process_gone'
])

const toDesktopExceptionEvent = (event: PostHogEventPayload): PostHogEventPayload | null => {
  if (event.event !== 'app_error_seen') return null
  const source = getStringProperty(event.properties, 'source') ?? 'desktop'
  const action = getStringProperty(event.properties, 'action') ?? 'error'
  const errorCode = getStringProperty(event.properties, 'error_code') ?? 'DesktopError'
  const stack = getStringProperty(event.properties, 'error_stack')
  return toPostHogExceptionEvent({
    distinctId: event.distinct_id,
    timestamp: event.timestamp,
    serviceName: DESKTOP_SERVICE_NAME,
    environment: getStringProperty(event.properties, 'environment'),
    type: errorCode,
    // Never the message — desktop crash messages can embed note content. The
    // synthetic label + real stack frames give the code location instead.
    message: `${DESKTOP_SERVICE_NAME}:${source}:${action}:${errorCode}`,
    stack,
    source,
    action,
    handled: !UNHANDLED_DESKTOP_ACTIONS.has(action),
    platform: source === 'renderer' ? 'web:javascript' : 'node:javascript',
    properties: event.properties
  })
}

const mirrorTelemetryBatchToPostHog = async (
  env: TelemetryEnv,
  batch: TelemetryBatch,
  hashes: BatchHashes,
  userId?: string
): Promise<void> => {
  if (!env.POSTHOG_API_KEY || !env.POSTHOG_HOST) return

  const distinctOverride = userId || undefined
  const payload = toPostHogBatchPayload(
    env.POSTHOG_API_KEY,
    batch,
    hashes.installHash,
    env.ENVIRONMENT,
    distinctOverride
  )
  const identifyEvents: PostHogEventPayload[] = distinctOverride
    ? [
        {
          event: '$identify',
          distinct_id: distinctOverride,
          timestamp: new Date().toISOString(),
          properties: {
            $anon_distinct_id: desktopDistinctId(batch, hashes.installHash, env.ENVIRONMENT),
            service_name: DESKTOP_SERVICE_NAME
          }
        }
      ]
    : []
  const exceptionEvents = payload.batch
    .map(toDesktopExceptionEvent)
    .filter((event): event is PostHogEventPayload => event !== null)
  const logRecords = payload.batch
    .map(toDesktopLogRecord)
    .filter((record): record is PostHogLogRecordInput => record !== null)

  await Promise.all([
    sendPostHogBatch(env, [...identifyEvents, ...payload.batch, ...exceptionEvents]),
    sendPostHogLogs(env, logRecords)
  ])
}

export const writeTelemetryBatch = async (
  env: TelemetryEnv,
  batch: TelemetryBatch,
  options: TelemetryWriteOptions = {}
): Promise<{ accepted: number }> => {
  const installHash = await hashTelemetryId(env.TELEMETRY_HMAC_KEY, batch.installId)
  const sessionHash = await hashTelemetryId(env.TELEMETRY_HMAC_KEY, batch.sessionId)
  const hashes = { installHash, sessionHash }

  for (const event of batch.events) {
    const point = toDataPoint(batch, event, hashes)
    env.PRODUCT_TELEMETRY.writeDataPoint({
      blobs: point.blobs,
      doubles: point.doubles,
      indexes: point.indexes
    })
  }

  if (shouldMirrorTelemetryBatch(env)) {
    const mirrorPromise = mirrorTelemetryBatchToPostHog(env, batch, hashes, options.userId)
    if (options.waitUntil) {
      options.waitUntil(mirrorPromise)
    } else {
      await mirrorPromise
    }
  }

  return { accepted: batch.events.length }
}
