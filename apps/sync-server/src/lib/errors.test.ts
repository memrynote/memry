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

  it('schedules sanitized PostHog capture for unexpected request errors', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ status: 1 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const scheduled: Promise<unknown>[] = []
    const json = vi.fn(
      (payload: unknown, init: number) => new Response(JSON.stringify(payload), { status: init })
    )
    const context = {
      json,
      get: () => undefined,
      env: {
        POSTHOG_API_KEY: 'phc_test_project',
        POSTHOG_HOST: 'https://us.i.posthog.com',
        ENVIRONMENT: 'development'
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
    const batchCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/batch/'))
    expect(batchCall).toBeDefined()
    const init = batchCall?.[1]
    expect(init?.body).toBeDefined()
    const body = JSON.parse(init?.body as string) as {
      batch: Array<{ event: string; properties: Record<string, unknown> }>
    }
    expect(body.batch[0].event).toBe('server_error_seen')
    expect(body.batch[0].properties).toMatchObject({
      method: 'POST',
      path: '/sync/records/push/:value',
      error_code: 'UNHANDLED_ERROR',
      status_code: 500,
      handled: 0,
      error_message: 'record decode failed'
    })
    const payloadText = JSON.stringify(body)
    // Path identifiers stay scrubbed; the server's own (redacted) message is surfaced.
    expect(payloadText).not.toContain('550e8400-e29b-41d4-a716-446655440000')
    expect(payloadText).toContain('record decode failed')
  })
})
