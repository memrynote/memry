import { Hono, type Context } from 'hono'
import { z } from 'zod'

import { AppError, ErrorCodes } from '../lib/errors'
import { authMiddleware } from '../middleware/auth'
import { createRateLimiter } from '../middleware/rate-limit'
import {
  createLinkingSession,
  getSession,
  transitionToScanned,
  transitionToApproved,
  transitionToCompleted
} from '../services/linking'
import { waitUntilCaptured } from '../services/analytics'
import type { AppContext } from '../types'

// Key linking buckets by the request's sessionId so concurrent devices and
// repeated attempts get independent budgets. These routes are unauthenticated;
// keying by IP would collapse every local profile (and devices behind one NAT)
// into one shared bucket. Falls back to userId/IP when the body has no sessionId.
const sessionIdentifier = async (c: Context<AppContext>): Promise<string | null> => {
  try {
    const body = (await c.req.json()) as { sessionId?: unknown }
    return typeof body?.sessionId === 'string' ? `session:${body.sessionId}` : null
  } catch {
    return null
  }
}

const linkingRateLimit = createRateLimiter({
  maxRequests: 5,
  windowSeconds: 300,
  keyPrefix: 'linking',
  identifier: sessionIdentifier
})

// Polled by the new device every few seconds while it waits for approval, so
// the budget must comfortably exceed that cadence for a single session.
const linkingCompleteRateLimit = createRateLimiter({
  maxRequests: 30,
  windowSeconds: 60,
  keyPrefix: 'linking_complete',
  identifier: sessionIdentifier
})

const InitiateLinkingSchema = z.object({
  ephemeralPublicKey: z.string().min(1)
})

const ScanLinkingSchema = z.object({
  sessionId: z.string().uuid(),
  newDevicePublicKey: z.string().min(1),
  newDeviceConfirm: z.string().min(1),
  linkingSecret: z.string().min(1),
  scanConfirm: z.string().min(1),
  scanProof: z.string().min(1),
  deviceName: z.string().min(1).max(100),
  devicePlatform: z.string().min(1).max(50)
})

const ApproveLinkingSchema = z.object({
  sessionId: z.string().uuid(),
  encryptedMasterKey: z.string().min(1),
  encryptedKeyNonce: z.string().min(1),
  keyConfirm: z.string().min(1),
  encryptedProviderAuth: z.string().min(1).optional(),
  encryptedProviderAuthNonce: z.string().min(1).optional(),
  providerAuthConfirm: z.string().min(1).optional(),
  providerAuthVersion: z.literal(1).optional(),
  encryptedVaultTransfer: z.string().min(1).optional(),
  encryptedVaultTransferNonce: z.string().min(1).optional(),
  vaultTransferConfirm: z.string().min(1).optional(),
  vaultTransferVersion: z.literal(1).optional()
})

const CompleteLinkingSchema = z.object({
  sessionId: z.string().uuid()
})

const linking = new Hono<AppContext>()

linking.post('/initiate', authMiddleware, linkingRateLimit, async (c) => {
  const body: unknown = await c.req.json()
  const parsed = InitiateLinkingSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!

  const { sessionId, expiresAt, linkingSecret } = await createLinkingSession(
    c.env.DB,
    userId,
    deviceId,
    parsed.data.ephemeralPublicKey
  )

  const doId = c.env.LINKING_SESSION.idFromName(sessionId)
  const stub = c.env.LINKING_SESSION.get(doId)
  await stub.fetch(
    new Request(new URL('/create', c.req.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        userId,
        initiatorDeviceId: deviceId,
        expiresAt
      })
    })
  )

  return c.json({ sessionId, expiresAt, linkingSecret })
})

linking.post('/scan', linkingRateLimit, async (c) => {
  const body: unknown = await c.req.json()
  const parsed = ScanLinkingSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const { sessionId, newDevicePublicKey, newDeviceConfirm, linkingSecret, scanConfirm, scanProof } =
    parsed.data
  const scannerIp = c.req.header('cf-connecting-ip') || null

  const { userId, initiatorDeviceId } = await transitionToScanned(
    c.env.DB,
    sessionId,
    newDevicePublicKey,
    newDeviceConfirm,
    linkingSecret,
    scanConfirm,
    scanProof,
    scannerIp
  )

  const doId = c.env.LINKING_SESSION.idFromName(sessionId)
  const stub = c.env.LINKING_SESSION.get(doId)
  await stub.fetch(
    new Request(new URL('/scan', c.req.url), {
      method: 'POST'
    })
  )

  const syncDoId = c.env.USER_SYNC_STATE.idFromName(userId)
  const syncStub = c.env.USER_SYNC_STATE.get(syncDoId)
  waitUntilCaptured(
    c,
    syncStub.fetch(
      new Request(new URL('/notify-linking', c.req.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'linking_request',
          targetDeviceId: initiatorDeviceId,
          payload: {
            sessionId,
            newDeviceName: parsed.data.deviceName,
            newDevicePlatform: parsed.data.devicePlatform
          }
        })
      })
    ),
    { source: 'UserSyncState', action: 'linking_request_notify_failed' }
  )

  return c.json({ success: true, status: 'scanned' })
})

linking.get('/session/:sessionId', authMiddleware, async (c) => {
  const sessionId = c.req.param('sessionId')
  const userId = c.get('userId')!

  const session = await getSession(c.env.DB, sessionId)
  if (!session || session.user_id !== userId) {
    throw new AppError(ErrorCodes.LINKING_SESSION_NOT_FOUND, 'Linking session not found', 404)
  }

  return c.json({
    sessionId: session.id,
    status: session.status,
    newDevicePublicKey: session.new_device_public_key,
    newDeviceConfirm: session.new_device_confirm,
    expiresAt: session.expires_at
  })
})

linking.post('/approve', authMiddleware, linkingRateLimit, async (c) => {
  const body: unknown = await c.req.json()
  const parsed = ApproveLinkingSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const userId = c.get('userId')!
  const {
    sessionId,
    encryptedMasterKey,
    encryptedKeyNonce,
    keyConfirm,
    encryptedProviderAuth,
    encryptedProviderAuthNonce,
    providerAuthConfirm,
    providerAuthVersion,
    encryptedVaultTransfer,
    encryptedVaultTransferNonce,
    vaultTransferConfirm,
    vaultTransferVersion
  } = parsed.data

  await transitionToApproved(
    c.env.DB,
    sessionId,
    userId,
    encryptedMasterKey,
    encryptedKeyNonce,
    keyConfirm,
    encryptedProviderAuth &&
      encryptedProviderAuthNonce &&
      providerAuthConfirm &&
      providerAuthVersion
      ? {
          encryptedProviderAuth,
          encryptedProviderAuthNonce,
          providerAuthConfirm,
          providerAuthVersion
        }
      : undefined,
    encryptedVaultTransfer &&
      encryptedVaultTransferNonce &&
      vaultTransferConfirm &&
      vaultTransferVersion
      ? {
          encryptedVaultTransfer,
          encryptedVaultTransferNonce,
          vaultTransferConfirm,
          vaultTransferVersion
        }
      : undefined
  )

  const doId = c.env.LINKING_SESSION.idFromName(sessionId)
  const stub = c.env.LINKING_SESSION.get(doId)
  await stub.fetch(
    new Request(new URL('/approve', c.req.url), {
      method: 'POST'
    })
  )

  const session = await getSession(c.env.DB, sessionId)
  if (session) {
    const syncDoId = c.env.USER_SYNC_STATE.idFromName(userId)
    const syncStub = c.env.USER_SYNC_STATE.get(syncDoId)
    waitUntilCaptured(
      c,
      syncStub.fetch(
        new Request(new URL('/notify-linking', c.req.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'linking_approved',
            targetDeviceId: session.initiator_device_id,
            payload: { sessionId }
          })
        })
      ),
      { source: 'UserSyncState', action: 'linking_approved_notify_failed' }
    )
  }

  return c.json({ success: true, status: 'approved' })
})

linking.post('/complete', linkingCompleteRateLimit, async (c) => {
  const body: unknown = await c.req.json()
  const parsed = CompleteLinkingSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const { sessionId } = parsed.data
  const callerIp = c.req.header('cf-connecting-ip') || null

  const keyData = await transitionToCompleted(c.env.DB, sessionId, callerIp)

  const doId = c.env.LINKING_SESSION.idFromName(sessionId)
  const stub = c.env.LINKING_SESSION.get(doId)
  await stub.fetch(
    new Request(new URL('/complete', c.req.url), {
      method: 'POST'
    })
  )

  return c.json({
    success: true,
    encryptedMasterKey: keyData.encryptedMasterKey,
    encryptedKeyNonce: keyData.encryptedKeyNonce,
    keyConfirm: keyData.keyConfirm,
    encryptedProviderAuth: keyData.encryptedProviderAuth,
    encryptedProviderAuthNonce: keyData.encryptedProviderAuthNonce,
    providerAuthConfirm: keyData.providerAuthConfirm,
    providerAuthVersion: keyData.providerAuthVersion,
    encryptedVaultTransfer: keyData.encryptedVaultTransfer,
    encryptedVaultTransferNonce: keyData.encryptedVaultTransferNonce,
    vaultTransferConfirm: keyData.vaultTransferConfirm,
    vaultTransferVersion: keyData.vaultTransferVersion
  })
})

export { linking }
