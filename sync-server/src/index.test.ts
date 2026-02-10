import { describe, expect, it, vi } from 'vitest'

import { app } from './index'

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
    ...overrides
  }
}

describe('sync-server app entry point', () => {
  it('returns health metadata in development even when secrets are missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const response = await app.request('http://localhost/health', {}, createEnv())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
    expect(body.environment).toBe('development')
    expect(typeof body.timestamp).toBe('number')
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
        ALLOWED_ORIGIN: 'https://app.memry.test'
      })
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.environment).toBe('production')
    expect(response.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains'
    )
  })
})
