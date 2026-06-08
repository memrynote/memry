import { Hono } from 'hono'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ErrorCodes, errorHandler } from '../lib/errors'
import type { AppContext } from '../types'

vi.mock('../services/linking', () => ({
  createLinkingSession: vi.fn(),
  getSession: vi.fn(),
  transitionToScanned: vi.fn(),
  transitionToApproved: vi.fn().mockResolvedValue(undefined),
  transitionToCompleted: vi.fn()
}))

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set('userId', 'user-1')
    c.set('deviceId', 'device-1')
    await next()
  })
}))

vi.mock('../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn().mockReturnValue(
    vi.fn().mockImplementation(async (_c: any, next: any) => {
      await next()
    })
  )
}))

import { linking } from './linking'
import {
  createLinkingSession,
  getSession,
  transitionToScanned,
  transitionToApproved,
  transitionToCompleted
} from '../services/linking'

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

const createApp = () => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/linking', linking)
  return app
}

const linkingStub = {
  fetch: vi.fn().mockResolvedValue(Response.json({ ok: true }))
}

const userSyncStub = {
  fetch: vi.fn().mockResolvedValue(Response.json({ ok: true }))
}

const createEnv = () => ({
  DB: {} as D1Database,
  STORAGE: {} as R2Bucket,
  USER_SYNC_STATE: {
    idFromName: vi.fn().mockReturnValue('user-sync-do-id'),
    get: vi.fn().mockReturnValue(userSyncStub)
  } as unknown as DurableObjectNamespace,
  LINKING_SESSION: {
    idFromName: vi.fn().mockReturnValue('linking-do-id'),
    get: vi.fn().mockReturnValue(linkingStub)
  } as unknown as DurableObjectNamespace,
  ENVIRONMENT: 'development',
  JWT_PUBLIC_KEY: 'pk',
  JWT_PRIVATE_KEY: 'sk',
  RESEND_API_KEY: 'resend',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost/callback',
  RECOVERY_DUMMY_SECRET: 'dummy'
})

const executionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {}
}

const jsonPost = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})

const makeSession = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  user_id: 'user-1',
  initiator_device_id: 'device-1',
  status: 'pending',
  new_device_public_key: 'new-pk',
  new_device_confirm: 'new-confirm',
  expires_at: 1234,
  ...overrides
})

describe('linking routes', () => {
  let app: ReturnType<typeof createApp>
  let env: ReturnType<typeof createEnv>

  beforeEach(() => {
    vi.clearAllMocks()
    linkingStub.fetch.mockResolvedValue(Response.json({ ok: true }))
    userSyncStub.fetch.mockResolvedValue(Response.json({ ok: true }))
    app = createApp()
    env = createEnv()
    vi.mocked(createLinkingSession).mockResolvedValue({
      sessionId: SESSION_ID,
      expiresAt: 1234,
      linkingSecret: 'secret'
    })
    vi.mocked(getSession).mockResolvedValue(makeSession() as any)
    vi.mocked(transitionToScanned).mockResolvedValue({
      userId: 'user-1',
      initiatorDeviceId: 'device-1'
    })
    vi.mocked(transitionToCompleted).mockResolvedValue({
      encryptedMasterKey: 'emk',
      encryptedKeyNonce: 'nonce',
      keyConfirm: 'confirm',
      encryptedProviderAuth: 'epa',
      encryptedProviderAuthNonce: 'epan',
      providerAuthConfirm: 'pac',
      providerAuthVersion: 1
    })
  })

  it('validates initiate payloads', async () => {
    const res = await app.request('/linking/initiate', jsonPost({}), env, executionCtx)

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.VALIDATION_ERROR
    )
  })

  it('initiates a linking session and creates its durable object state', async () => {
    const res = await app.request(
      'http://localhost/linking/initiate',
      jsonPost({ ephemeralPublicKey: 'eph-pk' }),
      env,
      executionCtx
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sessionId: SESSION_ID,
      expiresAt: 1234,
      linkingSecret: 'secret'
    })
    expect(createLinkingSession).toHaveBeenCalledWith(env.DB, 'user-1', 'device-1', 'eph-pk')
    expect(linkingStub.fetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST' }))
  })

  it('validates scan payloads', async () => {
    const res = await app.request('/linking/scan', jsonPost({ sessionId: SESSION_ID }), env)

    expect(res.status).toBe(400)
    expect(transitionToScanned).not.toHaveBeenCalled()
  })

  it('scans a session and notifies the initiator device', async () => {
    const res = await app.request(
      'http://localhost/linking/scan',
      {
        ...jsonPost({
          sessionId: SESSION_ID,
          newDevicePublicKey: 'new-pk',
          newDeviceConfirm: 'new-confirm',
          linkingSecret: 'secret',
          scanConfirm: 'scan-confirm',
          scanProof: 'scan-proof',
          deviceName: 'iPhone',
          devicePlatform: 'ios'
        }),
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': '1.2.3.4'
        }
      },
      env,
      executionCtx
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, status: 'scanned' })
    expect(transitionToScanned).toHaveBeenCalledWith(
      env.DB,
      SESSION_ID,
      'new-pk',
      'new-confirm',
      'secret',
      'scan-confirm',
      'scan-proof',
      '1.2.3.4'
    )
    expect(executionCtx.waitUntil).toHaveBeenCalledWith(expect.any(Promise))
  })

  it('returns 404 for a missing or foreign session lookup', async () => {
    vi.mocked(getSession).mockResolvedValueOnce(makeSession({ user_id: 'other-user' }) as any)

    const res = await app.request(`/linking/session/${SESSION_ID}`, { method: 'GET' }, env)

    expect(res.status).toBe(404)
  })

  it('returns a session owned by the authenticated user', async () => {
    const res = await app.request(`/linking/session/${SESSION_ID}`, { method: 'GET' }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sessionId: SESSION_ID,
      status: 'pending',
      newDevicePublicKey: 'new-pk',
      newDeviceConfirm: 'new-confirm',
      expiresAt: 1234
    })
  })

  it('validates approve payloads', async () => {
    const res = await app.request('/linking/approve', jsonPost({ sessionId: SESSION_ID }), env)

    expect(res.status).toBe(400)
    expect(transitionToApproved).not.toHaveBeenCalled()
  })

  it('approves a session with optional provider auth and notifies the initiator', async () => {
    const res = await app.request(
      'http://localhost/linking/approve',
      jsonPost({
        sessionId: SESSION_ID,
        encryptedMasterKey: 'emk',
        encryptedKeyNonce: 'nonce',
        keyConfirm: 'confirm',
        encryptedProviderAuth: 'epa',
        encryptedProviderAuthNonce: 'epan',
        providerAuthConfirm: 'pac',
        providerAuthVersion: 1
      }),
      env,
      executionCtx
    )

    expect(res.status).toBe(200)
    expect(transitionToApproved).toHaveBeenCalledWith(
      env.DB,
      SESSION_ID,
      'user-1',
      'emk',
      'nonce',
      'confirm',
      {
        encryptedProviderAuth: 'epa',
        encryptedProviderAuthNonce: 'epan',
        providerAuthConfirm: 'pac',
        providerAuthVersion: 1
      },
      undefined
    )
    expect(executionCtx.waitUntil).toHaveBeenCalledWith(expect.any(Promise))
  })

  it('approves without notifying when the session disappears after transition', async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null)

    const res = await app.request(
      'http://localhost/linking/approve',
      jsonPost({
        sessionId: SESSION_ID,
        encryptedMasterKey: 'emk',
        encryptedKeyNonce: 'nonce',
        keyConfirm: 'confirm'
      }),
      env,
      executionCtx
    )

    expect(res.status).toBe(200)
    expect(executionCtx.waitUntil).not.toHaveBeenCalled()
  })

  it('validates complete payloads', async () => {
    const res = await app.request('/linking/complete', jsonPost({ sessionId: 'not-a-uuid' }), env)

    expect(res.status).toBe(400)
    expect(transitionToCompleted).not.toHaveBeenCalled()
  })

  it('completes linking and returns encrypted key material', async () => {
    const res = await app.request(
      'http://localhost/linking/complete',
      {
        ...jsonPost({ sessionId: SESSION_ID }),
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': '4.3.2.1'
        }
      },
      env
    )

    expect(res.status).toBe(200)
    expect(transitionToCompleted).toHaveBeenCalledWith(env.DB, SESSION_ID, '4.3.2.1')
    expect(await res.json()).toEqual({
      success: true,
      encryptedMasterKey: 'emk',
      encryptedKeyNonce: 'nonce',
      keyConfirm: 'confirm',
      encryptedProviderAuth: 'epa',
      encryptedProviderAuthNonce: 'epan',
      providerAuthConfirm: 'pac',
      providerAuthVersion: 1
    })
  })

  it('forwards vault transfer to the service on approve', async () => {
    const res = await app.request(
      'http://localhost/linking/approve',
      jsonPost({
        sessionId: SESSION_ID,
        encryptedMasterKey: 'emk',
        encryptedKeyNonce: 'ekn',
        keyConfirm: 'kc',
        encryptedVaultTransfer: 'ct',
        encryptedVaultTransferNonce: 'nonce',
        vaultTransferConfirm: 'confirm',
        vaultTransferVersion: 1
      }),
      env,
      executionCtx
    )
    expect(res.status).toBe(200)
    expect(transitionToApproved).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      expect.any(String),
      'emk',
      'ekn',
      'kc',
      undefined,
      {
        encryptedVaultTransfer: 'ct',
        encryptedVaultTransferNonce: 'nonce',
        vaultTransferConfirm: 'confirm',
        vaultTransferVersion: 1
      }
    )
  })

  it('returns vault transfer on complete', async () => {
    vi.mocked(transitionToCompleted).mockResolvedValueOnce({
      encryptedMasterKey: 'emk',
      encryptedKeyNonce: 'ekn',
      keyConfirm: 'kc',
      encryptedVaultTransfer: 'ct',
      encryptedVaultTransferNonce: 'nonce',
      vaultTransferConfirm: 'confirm',
      vaultTransferVersion: 1
    })
    const res = await app.request(
      '/linking/complete',
      jsonPost({ sessionId: SESSION_ID }),
      env,
      executionCtx
    )
    const body = (await res.json()) as Record<string, unknown>
    expect(body.encryptedVaultTransfer).toBe('ct')
    expect(body.vaultTransferVersion).toBe(1)
  })
})
