import { redactSensitive } from '@memry/contracts/telemetry-api'

import { createLogger } from '../lib/logger'
import type { Bindings } from '../types'
import { capturePostHogEvents, type PostHogEvent } from './posthog'
import { pushPostHogLogs, type LogRecord } from './posthog-logs'
import { hashTelemetryId } from './telemetry'

// Server-side product/business events, errors and logs → PostHog, the same sink
// desktop telemetry uses. Every server-emitted signal shares one distinct_id per
// environment (server events are not attributed to an individual end user); actor
// context (user/device/vault id) rides along as PostHog properties instead.
// Server rows are tagged properties.surface = 'server'. Detailed error
// messages/stacks are redacted and go to PostHog Logs only, never to the event.

const logger = createLogger('Analytics')

const SERVER_SURFACE = 'server'

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
  TELEMETRY_HMAC_KEY: Bindings['TELEMETRY_HMAC_KEY']
  ENVIRONMENT?: Bindings['ENVIRONMENT']
  POSTHOG_KEY?: Bindings['POSTHOG_KEY']
  POSTHOG_HOST?: Bindings['POSTHOG_HOST']
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

// Fixed per environment, not per caller — server business/error/log events are
// attributed to one pseudo-actor ("the server"), not an individual end user.
// Any real actor (user/device/vault id) the caller knows about rides along as a
// property instead; see captureBusinessEvent's user_id and captureServerError's
// detail.user_id/device_id/vault_id.
const serverDistinctId = (env: AnalyticsEnv): string =>
  `memry_server_${safeLabel(env.ENVIRONMENT, 'unknown')}`

export const captureBusinessEvent = async (
  env: AnalyticsEnv,
  event: string,
  distinctId: string,
  properties: Record<string, AnalyticsPropertyValue> = {}
): Promise<void> => {
  try {
    // distinctId is a raw DB user.id at most call sites — PostHog is a
    // third-party sink, so it must only ever see the opaque hash, same as
    // desktop's install id and the diagnostics route's installHash.
    const hashedUserId = await hashTelemetryId(env.TELEMETRY_HMAC_KEY, distinctId)
    const posthogEvent: PostHogEvent = {
      event,
      distinct_id: serverDistinctId(env),
      properties: {
        ...properties,
        // Trusted keys are assigned after the spread (not before) so a
        // caller-supplied property of the same name can never clobber them.
        user_id: hashedUserId,
        surface: SERVER_SURFACE,
        environment: env.ENVIRONMENT
      }
    }
    await capturePostHogEvents(env, [posthogEvent])
  } catch (error) {
    logger.warn('Business event capture failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
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
  const distinctId = serverDistinctId(env)

  // Message + stack are the parts that can embed user content — redact and keep
  // them ONLY in PostHog Logs, never in the PostHog event.
  const rawMessage =
    input.error instanceof Error
      ? input.error.message
      : typeof input.error === 'string'
        ? input.error
        : undefined
  const rawStack = input.error instanceof Error ? input.error.stack : undefined
  const realMessage = rawMessage ? truncate(redactSensitive(rawMessage), 500) : undefined
  const realStack = rawStack ? truncate(redactSensitive(rawStack), 4000) : undefined

  const baseDetail = {
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
    ...(realStack ? { stack: realStack } : {})
  }

  // Local logger → Cloudflare's own Workers console, first-party: keep the raw
  // ids so they stay useful for debugging in that trusted sink.
  const detail = {
    ...baseDetail,
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

  // PostHog Logs → third-party sink: hash user/device/vault ids the same way
  // captureBusinessEvent hashes distinct_id. Never let the raw value leave.
  // hashTelemetryId throws if TELEMETRY_HMAC_KEY is missing/empty; swallow
  // that per-id so a bad config just drops the id instead of throwing.
  const hashOrDrop = async (raw: string | undefined): Promise<string | undefined> => {
    if (!raw) return undefined
    try {
      return await hashTelemetryId(env.TELEMETRY_HMAC_KEY, raw)
    } catch (error) {
      logger.warn('Server error id hash failed', {
        error: error instanceof Error ? error.message : String(error)
      })
      return undefined
    }
  }
  const [hashedUserId, hashedDeviceId, hashedVaultId] = await Promise.all([
    hashOrDrop(input.userId),
    hashOrDrop(input.deviceId),
    hashOrDrop(input.vaultId)
  ])
  const postHogDetail = {
    ...baseDetail,
    ...(hashedUserId ? { user_id: hashedUserId } : {}),
    ...(hashedDeviceId ? { device_id: hashedDeviceId } : {}),
    ...(hashedVaultId ? { vault_id: hashedVaultId } : {})
  }

  const logRecord: LogRecord = {
    level: status >= 500 || !input.handled ? 'error' : 'warn',
    app: 'server',
    kind: 'error',
    distinctId,
    line: postHogDetail
  }
  await pushPostHogLogs(env, [logRecord])

  const posthogEvent: PostHogEvent = {
    event: 'server_error_seen',
    distinct_id: distinctId,
    properties: {
      action: input.action,
      source: input.source,
      error_type: errorType,
      error_code: errorCode,
      route_area: routeArea,
      path,
      status_code: status,
      handled: input.handled,
      surface: SERVER_SURFACE,
      environment: env.ENVIRONMENT
    }
  }
  await capturePostHogEvents(env, [posthogEvent])
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
  const posthogEvent: PostHogEvent = {
    event: 'server_log_recorded',
    distinct_id: serverDistinctId(env),
    properties: {
      level: input.level,
      action: input.action,
      source: input.source,
      path,
      surface: SERVER_SURFACE,
      environment: env.ENVIRONMENT,
      ...(typeof input.statusCode === 'number' ? { status_code: input.statusCode } : {})
    }
  }
  await capturePostHogEvents(env, [posthogEvent])
}

// Generic fire-and-forget scheduler shared by every background-capture call
// site (/telemetry/batch, /telemetry/logs, /diagnostics/report, sync.ts, and
// the business/error/log captures above) — not specific to business events.
export const safeWaitUntil = (
  c: { executionCtx?: { waitUntil?: (promise: Promise<unknown>) => void } },
  promise: Promise<unknown>
): void => {
  try {
    c.executionCtx?.waitUntil?.(promise)
  } catch (error) {
    logger.warn('Background task scheduling failed', { error })
  }
}

// An AppError-shaped rejection carries its own code AND status, which means the
// throwing code already classified itself. Duck-typed rather than
// `instanceof AppError` because lib/errors.ts imports this module.
const isClassifiedError = (error: unknown): boolean =>
  error !== null &&
  typeof error === 'object' &&
  typeof (error as { code?: unknown }).code === 'string' &&
  typeof (error as { statusCode?: unknown }).statusCode === 'number'

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
        // Mirror errorHandler: a typed error is an expected condition, so let
        // its own code/status through and mark it handled. Only an untyped
        // rejection is a genuine unhandled defect worth a 500 (#1997).
        ...(isClassifiedError(error)
          ? { handled: true }
          : { errorCode: 'WAIT_UNTIL_REJECTED', statusCode: 500, handled: false })
      })
    )
  )
}
