import type { TelemetryBatch, TelemetryEvent } from '@memry/contracts/telemetry-api'

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

interface BatchHashes {
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
}

export const writeTelemetryBatch = async (
  env: TelemetryEnv,
  batch: TelemetryBatch
): Promise<{ accepted: number }> => {
  const installHash = await hashTelemetryId(env.TELEMETRY_HMAC_KEY, batch.installId)
  const sessionHash = await hashTelemetryId(env.TELEMETRY_HMAC_KEY, batch.sessionId)

  for (const event of batch.events) {
    const point = toDataPoint(batch, event, { installHash, sessionHash })
    env.PRODUCT_TELEMETRY.writeDataPoint({
      blobs: point.blobs,
      doubles: point.doubles,
      indexes: point.indexes
    })
  }

  return { accepted: batch.events.length }
}
