import { createLogger } from '../lib/logger'
import type { Bindings } from '../types'

const POSTHOG_BATCH_PATH = '/batch/'
const SERVER_SERVICE_NAME = 'memry-sync-server'
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_SEGMENT = /^[a-z0-9_.:-]{1,32}$/i

const logger = createLogger('PostHog')

export interface PostHogEnv {
  POSTHOG_API_KEY?: Bindings['POSTHOG_API_KEY']
  POSTHOG_HOST?: Bindings['POSTHOG_HOST']
  ENVIRONMENT?: Bindings['ENVIRONMENT']
}

export interface PostHogEventPayload {
  event: string
  distinct_id: string
  timestamp?: string
  properties: Record<string, string | number | boolean>
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

const normalizePathSegment = (segment: string, index: number): string => {
  if (index > 2 || UUID_SEGMENT.test(segment) || !SAFE_SEGMENT.test(segment)) {
    return ':value'
  }
  return segment
}

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
    .map((segment, index) => normalizePathSegment(segment, index))

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

export const toPostHogBatchPayload = (
  apiKey: string,
  batch: PostHogEventPayload[]
): PostHogBatchPayload => ({
  api_key: apiKey,
  batch
})

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

export const captureServerError = async (
  env: PostHogEnv,
  input: ServerErrorCaptureInput
): Promise<void> => {
  const path = normalizeServerPath(input.path)
  await sendPostHogBatch(env, [
    {
      event: 'server_error_seen',
      distinct_id: serverDistinctId(env),
      timestamp: new Date().toISOString(),
      properties: {
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
    }
  ])
}

export const captureServerLog = async (
  env: PostHogEnv,
  input: ServerLogCaptureInput
): Promise<void> => {
  const path = normalizeServerPath(input.path)
  await sendPostHogBatch(env, [
    {
      event: 'server_log_recorded',
      distinct_id: serverDistinctId(env),
      timestamp: new Date().toISOString(),
      properties: {
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
