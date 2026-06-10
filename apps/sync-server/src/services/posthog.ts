import { createLogger } from '../lib/logger'
import type { Bindings } from '../types'

const POSTHOG_BATCH_PATH = '/batch/'
const POSTHOG_LOGS_PATH = '/i/v1/logs'
const POSTHOG_BRIDGE_SCOPE_NAME = 'memry-posthog-bridge'
const POSTHOG_BRIDGE_SCOPE_VERSION = '1.0.0'
const SERVER_SERVICE_NAME = 'memry-sync-server'
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

const logger = createLogger('PostHog')

export interface PostHogEnv {
  POSTHOG_API_KEY?: Bindings['POSTHOG_API_KEY']
  POSTHOG_HOST?: Bindings['POSTHOG_HOST']
  ENVIRONMENT?: Bindings['ENVIRONMENT']
}

export type PostHogPropertyValue =
  | string
  | number
  | boolean
  | null
  | PostHogPropertyValue[]
  | { [key: string]: PostHogPropertyValue }

export interface PostHogEventPayload {
  event: string
  distinct_id: string
  timestamp?: string
  properties: Record<string, PostHogPropertyValue>
}

export interface PostHogBatchPayload {
  api_key: string
  batch: PostHogEventPayload[]
}

export interface ServerErrorCaptureInput {
  error: unknown
  method?: string
  path?: string
  source: string
  action: string
  statusCode?: number
  errorCode?: string
  handled: boolean
}

export interface ServerLogCaptureInput {
  level: 'debug' | 'info' | 'warn' | 'error'
  method?: string
  path?: string
  source: string
  action: string
  statusCode?: number
}

export type PostHogLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type PostHogLogAttributeValue = string | number | boolean
export type PostHogExceptionPlatform = 'node:javascript' | 'web:javascript'

export interface PostHogLogRecordInput {
  serviceName: string
  environment?: string
  distinctId: string
  timestamp?: string
  level: PostHogLogLevel
  body: string
  attributes: Record<string, PostHogLogAttributeValue>
}

export interface PostHogExceptionInput {
  distinctId: string
  timestamp?: string
  serviceName: string
  environment?: string
  type: string
  message: string
  source: string
  action: string
  handled: boolean
  platform: PostHogExceptionPlatform
  properties: Record<string, PostHogPropertyValue>
}

interface WaitUntilContext {
  env: PostHogEnv
  req: {
    method?: string
    path?: string
    url?: string
  }
  executionCtx: {
    waitUntil(promise: Promise<unknown>): void
  }
}

const normalizePostHogHost = (host: string): string => host.replace(/\/+$/, '')

const safeLabel = (value: string | undefined, fallback: string): string => {
  if (!value) return fallback
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80) || fallback
}

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

const serverDistinctId = (env: PostHogEnv): string =>
  `memry_sync_server_${safeLabel(env.ENVIRONMENT, 'unknown')}`

const toDiagnosticBody = (...parts: Array<string | undefined>): string =>
  parts.map((part) => safeLabel(part, 'unknown')).join(':')

const toUnixNano = (timestamp: string | undefined): string => {
  const millis = timestamp ? Date.parse(timestamp) : Date.now()
  const safeMillis = Number.isFinite(millis) ? millis : Date.now()
  return `${safeMillis}000000`
}

type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: number }
  | { doubleValue: number }

interface OtlpKeyValue {
  key: string
  value: OtlpAnyValue
}

const OTLP_SEVERITY_MAP: Record<PostHogLogLevel, { text: string; number: number }> = {
  trace: { text: 'TRACE', number: 1 },
  debug: { text: 'DEBUG', number: 5 },
  info: { text: 'INFO', number: 9 },
  warn: { text: 'WARN', number: 13 },
  error: { text: 'ERROR', number: 17 },
  fatal: { text: 'FATAL', number: 21 }
}

const toOtlpAnyValue = (value: PostHogLogAttributeValue): OtlpAnyValue => {
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { stringValue: String(value) }
    if (Number.isInteger(value)) return { intValue: value }
    return { doubleValue: value }
  }
  return { stringValue: value }
}

const toOtlpKeyValueList = (
  attributes: Record<string, PostHogLogAttributeValue | undefined>
): OtlpKeyValue[] =>
  Object.entries(attributes)
    .filter((entry): entry is [string, PostHogLogAttributeValue] => entry[1] !== undefined)
    .map(([key, value]) => ({ key, value: toOtlpAnyValue(value) }))

const toOtlpLogRecord = (record: PostHogLogRecordInput) => {
  const severity = OTLP_SEVERITY_MAP[record.level] ?? OTLP_SEVERITY_MAP.info
  const timeUnixNano = toUnixNano(record.timestamp)
  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityNumber: severity.number,
    severityText: severity.text,
    body: { stringValue: safeLabel(record.body, 'memry_log') },
    attributes: toOtlpKeyValueList({
      posthogDistinctId: record.distinctId,
      ...record.attributes
    })
  }
}

export const toPostHogLogsPayload = (records: PostHogLogRecordInput[]) => {
  const groups = new Map<string, PostHogLogRecordInput[]>()
  for (const record of records) {
    const key = `${record.serviceName}|${record.environment ?? ''}`
    groups.set(key, [...(groups.get(key) ?? []), record])
  }

  return {
    resourceLogs: Array.from(groups.values()).map((group) => {
      const first = group[0]
      return {
        resource: {
          attributes: toOtlpKeyValueList({
            'service.name': first.serviceName,
            'deployment.environment': first.environment
          })
        },
        scopeLogs: [
          {
            scope: {
              name: POSTHOG_BRIDGE_SCOPE_NAME,
              version: POSTHOG_BRIDGE_SCOPE_VERSION
            },
            logRecords: group.map(toOtlpLogRecord)
          }
        ]
      }
    })
  }
}

export const toPostHogBatchPayload = (
  apiKey: string,
  batch: PostHogEventPayload[]
): PostHogBatchPayload => ({
  api_key: apiKey,
  batch
})

export const toPostHogExceptionEvent = (input: PostHogExceptionInput): PostHogEventPayload => {
  const exceptionType = safeLabel(input.type, 'Error')
  const exceptionMessage = safeLabel(input.message, 'memry_error')
  const source = safeLabel(input.source, 'diagnostics')
  const action = safeLabel(input.action, 'error')

  return {
    event: '$exception',
    distinct_id: input.distinctId,
    timestamp: input.timestamp,
    properties: {
      ...input.properties,
      service_name: input.serviceName,
      ...(input.environment ? { environment: input.environment } : {}),
      $exception_type: exceptionType,
      $exception_message: exceptionMessage,
      $exception_level: 'error',
      $exception_list: [
        {
          type: exceptionType,
          value: exceptionMessage,
          mechanism: {
            type: 'generic',
            handled: input.handled
          },
          stacktrace: {
            type: 'raw',
            frames: [
              {
                platform: input.platform,
                filename: input.serviceName,
                module: source,
                function: action,
                in_app: true
              }
            ]
          }
        }
      ]
    }
  }
}

export const sendPostHogBatch = async (
  env: PostHogEnv,
  batch: PostHogEventPayload[]
): Promise<void> => {
  if (!env.POSTHOG_API_KEY || !env.POSTHOG_HOST || batch.length === 0) return

  try {
    const response = await fetch(`${normalizePostHogHost(env.POSTHOG_HOST)}${POSTHOG_BATCH_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toPostHogBatchPayload(env.POSTHOG_API_KEY, batch))
    })

    if (!response.ok) {
      logger.warn('PostHog batch rejected', { status: response.status })
    }
  } catch (error) {
    logger.warn('PostHog batch failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export const sendPostHogLogs = async (
  env: PostHogEnv,
  records: PostHogLogRecordInput[]
): Promise<void> => {
  if (!env.POSTHOG_API_KEY || !env.POSTHOG_HOST || records.length === 0) return

  try {
    const url = `${normalizePostHogHost(env.POSTHOG_HOST)}${POSTHOG_LOGS_PATH}?token=${encodeURIComponent(
      env.POSTHOG_API_KEY
    )}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toPostHogLogsPayload(records))
    })

    if (!response.ok) {
      logger.warn('PostHog logs rejected', { status: response.status })
    }
  } catch (error) {
    logger.warn('PostHog logs failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export const captureServerError = async (
  env: PostHogEnv,
  input: ServerErrorCaptureInput
): Promise<void> => {
  const path = normalizeServerPath(input.path)
  const timestamp = new Date().toISOString()
  const distinctId = serverDistinctId(env)
  const properties: Record<string, PostHogPropertyValue> = {
    service_name: SERVER_SERVICE_NAME,
    environment: safeLabel(env.ENVIRONMENT, 'unknown'),
    method: safeLabel(input.method?.toUpperCase(), 'UNKNOWN'),
    path,
    route_area: getRouteArea(path),
    source: safeLabel(input.source, 'server'),
    action: safeLabel(input.action, 'error'),
    level: 'error',
    error_type: getErrorType(input.error),
    error_code: safeLabel(
      input.errorCode ?? getErrorCode(input.error, 'UNHANDLED_ERROR'),
      'UNHANDLED_ERROR'
    ),
    status_code: input.statusCode ?? getStatusCode(input.error, 500),
    handled: input.handled ? 1 : 0
  }
  const event: PostHogEventPayload = {
    event: 'server_error_seen',
    distinct_id: distinctId,
    timestamp,
    properties
  }
  const exceptionEvent = toPostHogExceptionEvent({
    distinctId,
    timestamp,
    serviceName: SERVER_SERVICE_NAME,
    environment: safeLabel(env.ENVIRONMENT, 'unknown'),
    type: String(properties.error_type),
    message: toDiagnosticBody(
      SERVER_SERVICE_NAME,
      String(properties.source),
      String(properties.action),
      String(properties.error_code)
    ),
    source: String(properties.source),
    action: String(properties.action),
    handled: input.handled,
    platform: 'node:javascript',
    properties
  })
  const logRecord: PostHogLogRecordInput = {
    serviceName: SERVER_SERVICE_NAME,
    environment: safeLabel(env.ENVIRONMENT, 'unknown'),
    distinctId,
    timestamp,
    level: 'error',
    body: toDiagnosticBody(
      SERVER_SERVICE_NAME,
      String(properties.source),
      String(properties.action),
      String(properties.error_code)
    ),
    attributes: {
      event_name: event.event,
      method: String(properties.method),
      path: String(properties.path),
      route_area: String(properties.route_area),
      source: String(properties.source),
      action: String(properties.action),
      error_type: String(properties.error_type),
      error_code: String(properties.error_code),
      status_code: Number(properties.status_code),
      handled: input.handled
    }
  }

  await Promise.all([
    sendPostHogBatch(env, [event, exceptionEvent]),
    sendPostHogLogs(env, [logRecord])
  ])
}

export const captureServerLog = async (
  env: PostHogEnv,
  input: ServerLogCaptureInput
): Promise<void> => {
  const path = normalizeServerPath(input.path)
  const timestamp = new Date().toISOString()
  const distinctId = serverDistinctId(env)
  const properties: Record<string, PostHogPropertyValue> = {
    service_name: SERVER_SERVICE_NAME,
    environment: safeLabel(env.ENVIRONMENT, 'unknown'),
    level: input.level,
    method: safeLabel(input.method?.toUpperCase(), 'UNKNOWN'),
    path,
    route_area: getRouteArea(path),
    source: safeLabel(input.source, 'server'),
    action: safeLabel(input.action, 'log'),
    ...(typeof input.statusCode === 'number' ? { status_code: input.statusCode } : {})
  }
  const event: PostHogEventPayload = {
    event: 'server_log_recorded',
    distinct_id: distinctId,
    timestamp,
    properties
  }
  const logRecord: PostHogLogRecordInput = {
    serviceName: SERVER_SERVICE_NAME,
    environment: safeLabel(env.ENVIRONMENT, 'unknown'),
    distinctId,
    timestamp,
    level: input.level,
    body: toDiagnosticBody(
      SERVER_SERVICE_NAME,
      String(properties.source),
      String(properties.action)
    ),
    attributes: {
      event_name: event.event,
      level: input.level,
      method: String(properties.method),
      path: String(properties.path),
      route_area: String(properties.route_area),
      source: String(properties.source),
      action: String(properties.action),
      ...(typeof input.statusCode === 'number' ? { status_code: input.statusCode } : {})
    }
  }

  await Promise.all([sendPostHogBatch(env, [event]), sendPostHogLogs(env, [logRecord])])
}

export const captureBusinessEvent = async (
  env: PostHogEnv,
  event: string,
  distinctId: string,
  properties: Record<string, PostHogPropertyValue>
): Promise<void> => {
  await sendPostHogBatch(env, [
    {
      event,
      distinct_id: distinctId,
      timestamp: new Date().toISOString(),
      properties: {
        service_name: SERVER_SERVICE_NAME,
        environment: safeLabel(env.ENVIRONMENT, 'unknown'),
        ...properties
      }
    }
  ])
}

export const waitUntilWithPostHog = (
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
