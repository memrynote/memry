import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppError, ErrorCodes, errorHandler, formatErrorResponse } from './errors'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sync-server error utilities', () => {
  it('creates and formats AppError responses', () => {
    const error = new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Bad token', 401)

    expect(error.code).toBe(ErrorCodes.AUTH_INVALID_TOKEN)
    expect(error.statusCode).toBe(401)
    expect(formatErrorResponse(error)).toEqual({
      error: { code: ErrorCodes.AUTH_INVALID_TOKEN, message: 'Bad token' }
    })
  })

  it('errorHandler returns app error payload with status code', async () => {
    const json = vi.fn(
      (payload: unknown, init: { status: number }) => new Response(JSON.stringify(payload), init)
    )
    const context = { json } as unknown as Parameters<typeof errorHandler>[1]

    const response = errorHandler(
      new AppError(ErrorCodes.SYNC_INVALID_CURSOR, 'cursor mismatch', 409),
      context
    )

    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body).toEqual({
      error: {
        code: ErrorCodes.SYNC_INVALID_CURSOR,
        message: 'cursor mismatch'
      }
    })
  })

  it('errorHandler converts unexpected errors to INTERNAL_ERROR', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const json = vi.fn(
      (payload: unknown, init: number) => new Response(JSON.stringify(payload), { status: init })
    )
    const context = { json } as unknown as Parameters<typeof errorHandler>[1]

    const response = errorHandler(new Error('boom'), context)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: 'Internal server error'
      }
    })
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"code":"UNHANDLED_ERROR"'))
  })

  it('schedules a sanitized PostHog event for unexpected request errors', async () => {
    const scheduled: Promise<unknown>[] = []
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const json = vi.fn(
      (payload: unknown, init: number) => new Response(JSON.stringify(payload), { status: init })
    )
    const context = {
      json,
      get: () => undefined,
      env: {
        ENVIRONMENT: 'development',
        POSTHOG_KEY: 'phc_test',
        POSTHOG_HOST: 'https://us.i.posthog.com'
      },
      req: {
        method: 'POST',
        path: '/sync/records/push/550e8400-e29b-41d4-a716-446655440000'
      },
      executionCtx: {
        waitUntil: vi.fn((promise: Promise<unknown>) => {
          scheduled.push(promise)
        })
      }
    } as unknown as Parameters<typeof errorHandler>[1]

    const response = errorHandler(new Error('record decode failed'), context)
    await scheduled[0]

    expect(response.status).toBe(500)
    const captureCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/batch/'))
    expect(captureCall).toBeDefined()
    const point = JSON.parse((captureCall![1] as RequestInit).body as string).batch[0] as {
      event: string
      distinct_id: string
      properties: Record<string, unknown>
    }
    expect(point.event).toBe('server_error_seen')
    expect(point.distinct_id).toBe('memry_server_development')
    expect(point.properties.surface).toBe('server')
    expect(point.properties.action).toBe('request_failed')
    expect(point.properties.source).toBe('ErrorHandler')
    expect(point.properties.error_code).toBe('UNHANDLED_ERROR')
    expect(point.properties.path).toBe('/sync/records/push/:value') // scrubbed
    expect(point.properties.status_code).toBe(500)
    // The raw path identifier and error message never reach the PostHog event.
    const payloadText = JSON.stringify(point)
    expect(payloadText).not.toContain('550e8400-e29b-41d4-a716-446655440000')
    expect(payloadText).not.toContain('record decode failed')
  })
})
