import type {
  LandingTelemetryBatch,
  LandingTelemetryEvent,
  TelemetryBatch,
  TelemetryEvent
} from '@memry/contracts/telemetry-api'

import { AppError, ErrorCodes } from '../lib/errors'
import type { Bindings } from '../types'

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
  ENVIRONMENT?: Bindings['ENVIRONMENT']
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

  return { accepted: batch.events.length }
}

// --- Landing web telemetry → LANDING_TELEMETRY dataset ---------------------
// AE datapoint layout (one point per event):
//   blob1=name, blob2=page, blob3=target, blob4=utm_source, blob5=utm_medium,
//   blob6=utm_campaign, blob7=utm_content, blob8=utm_term
//   double1=1 (event count — query with sum(_sample_interval))
//   index1=HMAC(visitorId) so distinct-visitor counts work without a raw id.
const stripQueryAndHash = (value: string): string => value.split(/[?#]/)[0] ?? ''

export const toLandingDataPoint = (
  event: LandingTelemetryEvent,
  visitorHash: string
): TelemetryDataPoint => ({
  blobs: [
    event.name,
    stripQueryAndHash(event.page),
    stripQueryAndHash(event.target ?? ''),
    event.utm_source ?? '',
    event.utm_medium ?? '',
    event.utm_campaign ?? '',
    event.utm_content ?? '',
    event.utm_term ?? ''
  ],
  doubles: [1],
  indexes: [visitorHash]
})

export interface LandingTelemetryEnv {
  LANDING_TELEMETRY: Bindings['LANDING_TELEMETRY']
  TELEMETRY_HMAC_KEY: Bindings['TELEMETRY_HMAC_KEY']
}

export const writeLandingTelemetryBatch = async (
  env: LandingTelemetryEnv,
  batch: LandingTelemetryBatch
): Promise<{ accepted: number }> => {
  const visitorHash = await hashTelemetryId(env.TELEMETRY_HMAC_KEY, batch.visitorId)

  for (const event of batch.events) {
    const point = toLandingDataPoint(event, visitorHash)
    env.LANDING_TELEMETRY.writeDataPoint({
      blobs: point.blobs,
      doubles: point.doubles,
      indexes: point.indexes
    })
  }

  return { accepted: batch.events.length }
}
