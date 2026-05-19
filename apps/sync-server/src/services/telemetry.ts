import type { TelemetryBatch, TelemetryEvent } from '@memry/contracts/telemetry-api'

import { AppError, ErrorCodes } from '../lib/errors'
import type { Bindings } from '../types'
import { sendPostHogBatch, type PostHogBatchPayload, type PostHogEventPayload } from './posthog'

const TELEMETRY_BLOB_COUNT = 20
const TELEMETRY_DOUBLE_COUNT = 13
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

export const toPostHogEvent = (
  batch: TelemetryBatch,
  event: TelemetryEvent,
  hashes: BatchHashes,
  environment?: string
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
    surface: event.surface,
    action: event.action,
    telemetry_session_id: hashes.sessionHash,
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

  return {
    event: event.name,
    distinct_id: hashes.installHash,
    timestamp: event.occurredAt,
    properties
  }
}

export const toPostHogBatchPayload = (
  apiKey: string,
  batch: TelemetryBatch,
  hashes: BatchHashes,
  environment?: string
): PostHogBatchPayload => ({
  api_key: apiKey,
  batch: batch.events.map((event) => toPostHogEvent(batch, event, hashes, environment))
})

const mirrorTelemetryBatchToPostHog = async (
  env: TelemetryEnv,
  batch: TelemetryBatch,
  hashes: BatchHashes
): Promise<void> => {
  if (!env.POSTHOG_API_KEY || !env.POSTHOG_HOST) return

  const payload = toPostHogBatchPayload(env.POSTHOG_API_KEY, batch, hashes, env.ENVIRONMENT)
  await sendPostHogBatch(env, payload.batch)
}

export const writeTelemetryBatch = async (
  env: TelemetryEnv,
  batch: TelemetryBatch
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

  await mirrorTelemetryBatchToPostHog(env, batch, hashes)

  return { accepted: batch.events.length }
}
