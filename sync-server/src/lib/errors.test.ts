import { describe, expect, it, vi } from 'vitest'

import { AppError, ErrorCodes, errorHandler, formatErrorResponse } from './errors'

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
})
