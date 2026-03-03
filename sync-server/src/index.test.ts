import { describe, expect, it, vi } from 'vitest'

import { app } from './index'

const ONE_MB = 1024 * 1024
const TEN_MB = 10 * ONE_MB

function createEnv(overrides?: Partial<Record<string, unknown>>) {
  return {
    DB: {} as D1Database,
    STORAGE: {} as R2Bucket,
    USER_SYNC_STATE: {} as DurableObjectNamespace,
    LINKING_SESSION: {} as DurableObjectNamespace,
    ENVIRONMENT: 'development',
    ALLOWED_ORIGIN: 'https://app.memry.test',
    JWT_PUBLIC_KEY: '',
    JWT_PRIVATE_KEY: '',
    RESEND_API_KEY: '',
    OTP_HMAC_KEY: '',
    RECOVERY_DUMMY_SECRET: '',
    ...overrides
  }
}

describe('sync-server app entry point', () => {
  it('returns health metadata in development even when secrets are missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const response = await app.request('http://localhost/health', {}, createEnv())

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(warnSpy).toHaveBeenCalled()
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('fails fast outside development when required secrets are missing', async () => {
    const response = await app.request(
      'http://localhost/health',
      {},
      createEnv({
        ENVIRONMENT: 'production',
        JWT_PUBLIC_KEY: '',
        JWT_PRIVATE_KEY: '',
        RESEND_API_KEY: ''
      })
    )

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error'
      }
    })
  })

  it('succeeds in production when required secrets are present', async () => {
    const response = await app.request(
      'http://localhost/health',
      {
        headers: {
          Origin: 'https://app.memry.test'
        }
      },
      createEnv({
        ENVIRONMENT: 'production',
        JWT_PUBLIC_KEY: 'public-key',
        JWT_PRIVATE_KEY: 'private-key',
        RESEND_API_KEY: 'resend-key',
        OTP_HMAC_KEY: 'test-hmac-key',
        RECOVERY_DUMMY_SECRET: 'test-dummy-secret',
        ALLOWED_ORIGIN: 'https://app.memry.test'
      })
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(response.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains'
    )
  })

  it('rejects oversized API bodies even when Content-Length is omitted', async () => {
    const request = new Request('http://localhost/health', {
      method: 'POST',
      body: new Uint8Array(ONE_MB + 1)
    })
    expect(request.headers.get('Content-Length')).toBeNull()

    const response = await app.request(request, {}, createEnv())

    expect(response.status).toBe(413)
    const body = await response.json()
    expect(body).toEqual({
      error: {
        code: 'VALIDATION_BODY_TOO_LARGE',
        message: 'Request body too large'
      }
    })
  })

  it('rejects oversized blob bodies even when Content-Length is omitted', async () => {
    const request = new Request('http://localhost/sync/blob/blob-key', {
      method: 'PUT',
      body: new Uint8Array(TEN_MB + 1)
    })
    expect(request.headers.get('Content-Length')).toBeNull()

    const response = await app.request(request, {}, createEnv())

    expect(response.status).toBe(413)
    const body = await response.json()
    expect(body).toEqual({
      error: {
        code: 'VALIDATION_BODY_TOO_LARGE',
        message: 'Request body too large'
      }
    })
  })

  it('uses a larger body limit for blob routes', async () => {
    const request = new Request('http://localhost/sync/blob/blob-key', {
      method: 'PUT',
      body: new Uint8Array(2 * ONE_MB)
    })

    const response = await app.request(request, {}, createEnv())

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body).toEqual({
      error: {
        code: 'AUTH_INVALID_TOKEN',
        message: 'Missing or malformed Authorization header'
      }
    })
  })
})
