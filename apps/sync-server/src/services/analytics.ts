import { redactSensitive } from '@memry/contracts/telemetry-api'

import { createLogger } from '../lib/logger'
import type { Bindings } from '../types'
import { hashTelemetryId } from './telemetry'

// Server-side product/business events land in the SAME Analytics Engine dataset
// as desktop telemetry, using the SAME blob/double layout as toDataPoint() so a
// single Grafana query reads every event. Server rows are tagged platform =
// surface = 'server'. Detailed error messages/stacks go to Cloudflare Workers
// logs only (never to Analytics Engine).

const logger = createLogger('Analytics')

const SERVER_PLATFORM = 'server'
const SERVER_SURFACE = 'server'
const BLOB_COUNT = 20
const DOUBLE_COUNT = 13

const STATIC_ROUTE_SEGMENTS = new Set([
  'approve',
  'attachments',
  'auth',
  'batch',
  'blob',
  'calendar',
  'callback',
  'channels',
  'changes',
  'checkout-token',
  'chunk',
  'chunks',
  'complete',
  'crdt',
  'devices',
  'github',
  'google',
  'google-calendar',
  'health',
  'initiate',
  'items',
  'linking',
  'logout',
  'manifest',
  'oauth',
  'otp',
  'paddle',
  'pull',
  'push',
  'records',
  'recovery',
  'recovery-info',
  'refresh',
  'request',
  'resend',
  'scan',
  'session',
  'setup',
  'snapshot',
  'status',
  'storage',
  'sync',
  'telemetry',
  'updates',
  'upload',
  'verify',
  'webhooks',
  'ws'
])

export interface AnalyticsEnv {
  PRODUCT_TELEMETRY: Bindings['PRODUCT_TELEMETRY']
  TELEMETRY_HMAC_KEY: Bindings['TELEMETRY_HMAC_KEY']
  ENVIRONMENT?: Bindings['ENVIRONMENT']
}

export type AnalyticsPropertyValue = string | number | boolean | null | undefined

export interface ServerErrorCaptureInput {
  error: unknown
  method?: string
  path?: string
  source: string
  action: string
  statusCode?: number
  errorCode?: string
  handled: boolean
  userId?: string
  deviceId?: string
  vaultId?: string
}

export interface ServerLogCaptureInput {
  level: 'debug' | 'info' | 'warn' | 'error'
  method?: string
  path?: string
  source: string
  action: string
  statusCode?: number
}

interface WaitUntilContext {
  env: AnalyticsEnv
  req: { method?: string; path?: string; url?: string }
  executionCtx: { waitUntil(promise: Promise<unknown>): void }
}

// --- pure helpers (ported from the removed PostHog service) ---

const safeLabel = (value: string | undefined, fallback: string): string => {
  if (!value) return fallback
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80) || fallback
}

const truncate = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value

const normalizePathSegment = (segment: string): string =>
  STATIC_ROUTE_SEGMENTS.has(segment.toLowerCase()) ? segment.toLowerCase() : ':value'

const normalizeServerPath = (path: string | undefined): string => {
  if (!path) return '/'
  let pathname = path
  try {
    pathname = new URL(path).pathname
  } catch {
    pathname = path.split('?')[0] ?? '/'
  }
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => normalizePathSegment(segment))
  return segments.length > 0 ? `/${segments.join('/')}` : '/'
}

const getRouteArea = (path: string): string => {
  const first = path.split('/').filter(Boolean)[0]
  return safeLabel(first, 'root')
}

const getStatusCode = (error: unknown, fallback: number): number => {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode
    if (typeof statusCode === 'number' && Number.isFinite(statusCode)) return statusCode
  }
  return fallback
}

const getErrorCode = (error: unknown, fallback: string): string => {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return safeLabel(code, fallback)
  }
  return fallback
}

const getErrorType = (error: unknown): string => {
  if (error instanceof Error && error.name) return safeLabel(error.name, 'Error')
  if (error && typeof error === 'object' && 'name' in error) {
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name.length > 0) return safeLabel(name, 'Error')
  }
  return typeof error === 'string' ? 'StringError' : 'UnknownError'
}

const getRequestPath = (req: WaitUntilContext['req']): string => req.path ?? req.url ?? '/'

const serverDistinctId = (env: AnalyticsEnv): string =>
  `memry_sync_server_${safeLabel(env.ENVIRONMENT, 'unknown')}`

const strProp = (
  properties: Record<string, AnalyticsPropertyValue>,
  key: string
): string | undefined => {
  const value = properties[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// Mirror desktop firstDimension: pick the first (sorted) string prop as a
// generic key/value dimension so business-event context survives into Grafana.
const firstStringDimension = (
  properties: Record<string, AnalyticsPropertyValue>
): { key: string; value: string } => {
  for (const key of Object.keys(properties).sort()) {
    const value = properties[key]
    if (typeof value === 'string' && value.length > 0) return { key, value }
  }
  return { key: '', value: '' }
}

const pad = <T>(arr: T[], len: number, fill: T): T[] =>
  arr.length >= len ? arr : [...arr, ...Array.from({ length: len - arr.length }, () => fill)]

interface ServerPoint {
  name: string
  distinctId: string
  action: string
  objectType?: string
  source?: string
  result?: string
  errorCode?: string
  dimKey?: string
  dimValue?: string
  errorCount?: number
  statusCode?: number
}

// Blob/double positions match toDataPoint() in telemetry.ts exactly.
const writeServerPoint = async (env: AnalyticsEnv, point: ServerPoint): Promise<void> => {
  try {
    const idHash = await hashTelemetryId(env.TELEMETRY_HMAC_KEY, point.distinctId)
    const blobs = pad(
      [
        point.name, // 1 event name
        '', // 2 schemaVersion (desktop-only)
        '', // 3 appVersion
        '', // 4 buildChannel
        SERVER_PLATFORM, // 5 platform
        '', // 6 arch
        '', // 7 locale
        '', // 8 timezone bucket
        '', // 9 authState
        '', // 10 syncState
        SERVER_SURFACE, // 11 surface
        safeLabel(point.action, 'unknown'), // 12 action
        point.objectType ?? '', // 13 objectType
        point.source ?? '', // 14 source
        point.result ?? '', // 15 result
        point.errorCode ?? '', // 16 errorCode
        point.dimKey ?? '', // 17 dimension key
        point.dimValue ?? '', // 18 dimension value
        '', // 19 sessionHash (desktop-only)
        '' // 20 reserved
      ],
      BLOB_COUNT,
      ''
    )
    const doubles = pad(
      [
        1, // 1 count
        0, // 2 durationMs
        0, // 3 itemCount
        0, // 4 byteCount
        0, // 5 queueCount
        0, // 6 resultCount
        point.errorCount ?? 0, // 7 errorCount
        0, // 8 retryCount
        0, // 9 activeSeconds
        0, // 10 value
        0, // 11 batchSize
        0, // 12 clientQueueDepth
        point.statusCode ?? 0 // 13 statusCode (server-only; 0 on desktop)
      ],
      DOUBLE_COUNT,
      0
    )
    env.PRODUCT_TELEMETRY.writeDataPoint({ blobs, doubles, indexes: [idHash] })
  } catch (error) {
    logger.warn('Analytics write failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export const captureBusinessEvent = async (
  env: AnalyticsEnv,
  event: string,
  distinctId: string,
  properties: Record<string, AnalyticsPropertyValue> = {}
): Promise<void> => {
  const dim = firstStringDimension(properties)
  await writeServerPoint(env, {
    name: event,
    distinctId,
    action: event,
    objectType: strProp(properties, 'object_type') ?? strProp(properties, 'objectType'),
    source: strProp(properties, 'source'),
    result: strProp(properties, 'result'),
    dimKey: dim.key,
    dimValue: dim.value
  })
}

export const captureServerError = async (
  env: AnalyticsEnv,
  input: ServerErrorCaptureInput
): Promise<void> => {
  const path = normalizeServerPath(input.path)
  const routeArea = getRouteArea(path)
  const status = input.statusCode ?? getStatusCode(input.error, 500)
  const errorCode = safeLabel(
    input.errorCode ?? getErrorCode(input.error, 'UNHANDLED_ERROR'),
    'UNHANDLED_ERROR'
  )
  const errorType = getErrorType(input.error)
  const distinctId = input.userId ?? serverDistinctId(env)

  // Message + stack are the parts that can embed user content — redact and keep
  // them ONLY in Cloudflare Workers logs, never in Analytics Engine.
  const rawMessage =
    input.error instanceof Error
      ? input.error.message
      : typeof input.error === 'string'
        ? input.error
        : undefined
  const rawStack = input.error instanceof Error ? input.error.stack : undefined
  const realMessage = rawMessage ? truncate(redactSensitive(rawMessage), 500) : undefined
  const realStack = rawStack ? truncate(redactSensitive(rawStack), 4000) : undefined

  const detail = {
    method: safeLabel(input.method?.toUpperCase(), 'UNKNOWN'),
    path,
    route_area: routeArea,
    source: input.source,
    action: input.action,
    error_type: errorType,
    error_code: errorCode,
    status_code: status,
    handled: input.handled,
    ...(realMessage ? { message: realMessage } : {}),
    ...(realStack ? { stack: realStack } : {}),
    ...(input.userId ? { user_id: input.userId } : {}),
    ...(input.deviceId ? { device_id: input.deviceId } : {}),
    ...(input.vaultId ? { vault_id: input.vaultId } : {})
  }
  // Unhandled or 5xx are genuine failures; handled 4xx are expected noise.
  if (status >= 500 || !input.handled) {
    logger.error('server_error_seen', detail)
  } else {
    logger.warn('server_error_seen', detail)
  }

  await writeServerPoint(env, {
    name: 'server_error_seen',
    distinctId,
    action: input.action,
    source: input.source,
    objectType: errorType,
    errorCode,
    result: routeArea,
    dimKey: 'path',
    dimValue: path,
    errorCount: 1,
    statusCode: status
  })
}

export const captureServerLog = async (
  env: AnalyticsEnv,
  input: ServerLogCaptureInput
): Promise<void> => {
  const path = normalizeServerPath(input.path)
  logger.info('server_log_recorded', {
    level: input.level,
    method: safeLabel(input.method?.toUpperCase(), 'UNKNOWN'),
    path,
    route_area: getRouteArea(path),
    source: input.source,
    action: input.action,
    ...(typeof input.statusCode === 'number' ? { status_code: input.statusCode } : {})
  })
  await writeServerPoint(env, {
    name: 'server_log_recorded',
    distinctId: serverDistinctId(env),
    action: input.action,
    source: input.source,
    result: input.level,
    dimKey: 'path',
    dimValue: path,
    statusCode: input.statusCode
  })
}

export const safeWaitUntil = (
  c: { executionCtx?: { waitUntil?: (promise: Promise<unknown>) => void } },
  promise: Promise<unknown>
): void => {
  try {
    c.executionCtx?.waitUntil?.(promise)
  } catch (error) {
    logger.warn('Business event capture failed', { error })
  }
}

export const waitUntilCaptured = (
  c: WaitUntilContext,
  promise: Promise<unknown>,
  metadata: { source: string; action: string }
): void => {
  c.executionCtx.waitUntil(
    promise.catch((error) =>
      captureServerError(c.env, {
        error,
        method: c.req.method,
        path: getRequestPath(c.req),
        source: metadata.source,
        action: metadata.action,
        errorCode: 'WAIT_UNTIL_REJECTED',
        statusCode: 500,
        handled: false
      })
    )
  )
}
