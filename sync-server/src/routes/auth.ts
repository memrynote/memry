/**
 * Auth Routes
 *
 * Implements all authentication endpoints:
 * - T042: POST /auth/otp/request
 * - T043: POST /auth/otp/verify
 * - T047a: POST /auth/otp/resend
 * - T044b: Rate limiting integration
 * - T048: GET /auth/oauth/:provider
 * - T049, T049a: POST /auth/oauth/:provider/callback
 * - T050, T050a, T050b: POST /auth/devices
 * - T051: POST /auth/setup
 * - T052b: POST /auth/refresh
 * - T104: POST /auth/linking/initiate
 * - T105: POST /auth/linking/scan
 * - T106: POST /auth/linking/approve
 * - T107: POST /auth/linking/complete
 */

import { Hono } from 'hono'
import type { Env } from '../index'
import {
  OtpRequestSchema,
  OtpVerifyRequestSchema,
  OtpResendRequestSchema,
  DeviceRegisterRequestSchema,
  RefreshTokenRequestSchema,
  FirstDeviceSetupRequestSchema,
  OAuthCallbackQuerySchema,
  OAuthInitiateQuerySchema,
  LogoutRequestSchema,
  type OtpRequestResponse,
  type OtpVerifyResponse,
  type OtpResendResponse,
  type DeviceRegisterResponse,
  type RefreshTokenResponse,
  type FirstDeviceSetupResponse,
  type OAuthInitiateResponse,
  type OAuthCallbackResponse,
  type RecoveryInfoResponse,
  type LogoutResponse
} from '../contracts/auth-api'
import type { Device, DevicePlatform } from '../contracts/sync-api'
import { createOtp, verifyOtp } from '../services/otp'
import { findOrCreateUserByEmail, getUserById, updateUser, userToPublic } from '../services/user'
import { issueTokenPair, rotateRefreshToken, hashToken } from '../services/auth'
import { createEmailService } from '../services/email'
import { checkRateLimit, RATE_LIMITS } from '../middleware/rate-limit'
import { authMiddleware, getAuth } from '../middleware/auth'
import {
  validationError,
  badRequest,
  SyncError,
  ErrorCode,
  notFound,
  linkingSessionNotFound,
  linkingSessionExpired,
  linkingInvalidState,
  linkingDeviceNotOwned,
  linkingConfirmMismatch,
  linkingSessionIncomplete
} from '../lib/errors'
import {
  LinkingInitiateRequestSchema,
  LinkingScanRequestSchema,
  LinkingApproveRequestSchema,
  LinkingCompleteRequestSchema,
  type LinkingInitiateResponse,
  type LinkingScanResponse,
  type LinkingApproveResponse,
  type LinkingCompleteResponse
} from '../contracts/linking-api'
import {
  generateLinkingToken,
  encodeQRPayload,
  isSessionExpired,
  calculateSessionExpiry,
  getLinkingSession,
  createLinkingSession,
  updateSessionToScanned,
  updateSessionToApproved,
  updateSessionToCompleted,
  verifyDeviceOwnership,
  hashLinkingToken,
  verifyLinkingToken
} from '../services/linking'
import { getDevicesByUserId } from '../services/device'

interface AuthVariables {
  auth: {
    userId: string
    deviceId: string
    tokenIssuedAt: number
    tokenExpiresAt: number
  }
}

interface OAuthState {
  state: string
  codeVerifier: string
  redirectUri: string
  createdAt: number
}

const AUTH_STATE_EXPIRY_MS = 10 * 60 * 1000 // 10 minutes

const authRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

// =============================================================================
// OTP Endpoints
// =============================================================================

/**
 * T042: POST /auth/otp/request
 * Request a one-time password for email login.
 * Rate limiting is done at the handler level with the actual email address.
 */
authRoutes.post('/otp/request', async (c) => {
  const body = await c.req.json()
  const parsed = OtpRequestSchema.safeParse(body)

  if (!parsed.success) {
    throw validationError('Invalid request', { issues: parsed.error.issues })
  }

  const { email } = parsed.data
  const normalizedEmail = email.toLowerCase()

  const rateKey = `otp_request:${normalizedEmail}`
  const rateCheck = await checkRateLimit(
    c.env.DB,
    rateKey,
    RATE_LIMITS.otp_request.requests,
    RATE_LIMITS.otp_request.windowMs
  )

  if (!rateCheck.allowed) {
    const retryAfter = Math.ceil((rateCheck.resetAt - Date.now()) / 1000)
    c.header('Retry-After', String(retryAfter))
    throw new SyncError('Too many OTP requests', ErrorCode.AUTH_RATE_LIMITED, 429, { retryAfter })
  }

  const { code, expiresAt } = await createOtp(c.env.DB, normalizedEmail)

  const emailService = createEmailService({
    apiKey: c.env.RESEND_API_KEY,
    fromEmail: c.env.EMAIL_FROM,
    fromName: c.env.EMAIL_FROM_NAME
  })

  const emailResult = await emailService.sendOtpCode(normalizedEmail, code)

  if (!emailResult.success) {
    console.error('Failed to send OTP email:', emailResult.error)
    throw new SyncError(
      'Failed to send verification email. Please try again.',
      ErrorCode.SERVER_INTERNAL_ERROR,
      500
    )
  }

  const response: OtpRequestResponse = {
    success: true,
    expiresAt
  }

  return c.json(response)
})

/**
 * T043: POST /auth/otp/verify
 * Verify OTP and get tokens.
 */
authRoutes.post('/otp/verify', async (c) => {
  const body = await c.req.json()
  const parsed = OtpVerifyRequestSchema.safeParse(body)

  if (!parsed.success) {
    throw validationError('Invalid request', { issues: parsed.error.issues })
  }

  const { email, code } = parsed.data
  const normalizedEmail = email.toLowerCase()

  const result = await verifyOtp(c.env.DB, normalizedEmail, code)

  if (!result.success) {
    throw result.error
  }

  const { user, isNew } = await findOrCreateUserByEmail(c.env.DB, normalizedEmail, 'email')

  if (!user.emailVerified) {
    await updateUser(c.env.DB, user.id, { emailVerified: true })
  }

  const now = Date.now()
  const tempDeviceId = await ensurePendingDevice(c.env.DB, user.id, now)

  const tokens = await issueTokenPair(c.env.DB, user.id, tempDeviceId, c.env.JWT_SECRET)

  const updatedUser = await getUserById(c.env.DB, user.id)

  const response: OtpVerifyResponse = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    user: userToPublic(updatedUser!),
    device: {
      id: tempDeviceId,
      name: 'Pending Registration',
      platform: 'macos',
      appVersion: '1.0.0',
      authPublicKey: '',
      linkedAt: now
    }
  }

  return c.json(response)
})

/**
 * T047a: POST /auth/otp/resend
 * Resend OTP code.
 * Rate limiting is done at the handler level with the actual email address.
 */
authRoutes.post('/otp/resend', async (c) => {
  const body = await c.req.json()
  const parsed = OtpResendRequestSchema.safeParse(body)

  if (!parsed.success) {
    throw validationError('Invalid request', { issues: parsed.error.issues })
  }

  const { email } = parsed.data
  const normalizedEmail = email.toLowerCase()

  const rateKey = `otp_request:${normalizedEmail}`
  const rateCheck = await checkRateLimit(
    c.env.DB,
    rateKey,
    RATE_LIMITS.otp_request.requests,
    RATE_LIMITS.otp_request.windowMs
  )

  if (!rateCheck.allowed) {
    const retryAfter = Math.ceil((rateCheck.resetAt - Date.now()) / 1000)
    c.header('Retry-After', String(retryAfter))
    throw new SyncError('Too many OTP requests', ErrorCode.AUTH_RATE_LIMITED, 429, { retryAfter })
  }

  const { code, expiresAt } = await createOtp(c.env.DB, normalizedEmail)

  const emailService = createEmailService({
    apiKey: c.env.RESEND_API_KEY,
    fromEmail: c.env.EMAIL_FROM,
    fromName: c.env.EMAIL_FROM_NAME
  })

  const emailResult = await emailService.sendOtpCode(normalizedEmail, code)

  if (!emailResult.success) {
    console.error('Failed to send OTP email:', emailResult.error)
    throw new SyncError(
      'Failed to send verification email. Please try again.',
      ErrorCode.SERVER_INTERNAL_ERROR,
      500
    )
  }

  const response: OtpResendResponse = {
    success: true,
    expiresAt
  }

  return c.json(response)
})

// =============================================================================
// OAuth Endpoints
// =============================================================================

/**
 * T048: GET /auth/oauth/:provider
 * Initiate OAuth flow.
 */
authRoutes.get('/oauth/:provider', async (c) => {
  const provider = c.req.param('provider')

  if (provider !== 'google') {
    throw badRequest(`Unsupported OAuth provider: ${provider}`)
  }

  const parsed = OAuthInitiateQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    throw validationError('Invalid OAuth initiation parameters', { issues: parsed.error.issues })
  }

  const { redirect_uri: redirectUri, code_challenge: codeChallenge, state } = parsed.data
  const createdAt = Date.now()

  const stateHash = await hashToken(state)
  await c.env.DB.prepare(
    `INSERT INTO oauth_states (id, state_hash, code_verifier, redirect_uri, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      stateHash,
      codeChallenge,
      redirectUri,
      createdAt,
      createdAt + AUTH_STATE_EXPIRY_MS
    )
    .run()

  const googleAuthUrl = buildGoogleAuthUrl({
    clientId: c.env.GOOGLE_CLIENT_ID,
    redirectUri,
    state,
    codeChallenge
  })

  const response: OAuthInitiateResponse = {
    authUrl: googleAuthUrl,
    state
  }

  return c.json(response)
})

/**
 * T049, T049a: POST /auth/oauth/:provider/callback
 * Handle OAuth callback.
 */
authRoutes.post('/oauth/:provider/callback', async (c) => {
  const provider = c.req.param('provider')

  if (provider !== 'google') {
    throw badRequest(`Unsupported OAuth provider: ${provider}`)
  }

  const body = await c.req.json()
  const parsed = OAuthCallbackQuerySchema.safeParse(body)

  if (!parsed.success) {
    throw validationError('Invalid callback parameters', { issues: parsed.error.issues })
  }

  const { code, state, error, error_description, code_verifier, redirect_uri } = parsed.data

  if (error) {
    throw new SyncError(
      error_description || `OAuth error: ${error}`,
      ErrorCode.AUTH_UNAUTHORIZED,
      401
    )
  }

  const stateHash = await hashToken(state)
  const storedState = await c.env.DB.prepare(
    `SELECT id, code_verifier, redirect_uri, expires_at
     FROM oauth_states
     WHERE state_hash = ?`
  )
    .bind(stateHash)
    .first<{ id: string; code_verifier: string; redirect_uri: string; expires_at: number }>()

  if (!storedState) {
    throw new SyncError('Invalid OAuth state', ErrorCode.AUTH_UNAUTHORIZED, 401)
  }

  if (storedState.expires_at < Date.now()) {
    await c.env.DB.prepare(`DELETE FROM oauth_states WHERE id = ?`).bind(storedState.id).run()
    throw new SyncError('OAuth state expired', ErrorCode.AUTH_UNAUTHORIZED, 401)
  }

  if (storedState.redirect_uri !== redirect_uri) {
    await c.env.DB.prepare(`DELETE FROM oauth_states WHERE id = ?`).bind(storedState.id).run()
    throw new SyncError('OAuth redirect URI mismatch', ErrorCode.AUTH_UNAUTHORIZED, 401)
  }

  if (storedState.code_verifier) {
    const expectedChallenge = await generateCodeChallenge(code_verifier)
    if (expectedChallenge !== storedState.code_verifier) {
      await c.env.DB.prepare(`DELETE FROM oauth_states WHERE id = ?`).bind(storedState.id).run()
      throw new SyncError('OAuth PKCE verification failed', ErrorCode.AUTH_UNAUTHORIZED, 401)
    }
  }

  await c.env.DB.prepare(`DELETE FROM oauth_states WHERE id = ?`).bind(storedState.id).run()

  const tokenResponse = await exchangeGoogleCode({
    code,
    codeVerifier: code_verifier,
    redirectUri: storedState.redirect_uri,
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET
  })

  const googleUser = await getGoogleUserInfo(tokenResponse.access_token)

  const { user, isNew } = await findOrCreateUserByEmail(
    c.env.DB,
    googleUser.email,
    'oauth',
    'google',
    googleUser.id
  )

  const now = Date.now()
  const tempDeviceId = await ensurePendingDevice(c.env.DB, user.id, now)

  const tokens = await issueTokenPair(c.env.DB, user.id, tempDeviceId, c.env.JWT_SECRET)

  const response: OAuthCallbackResponse = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    user: userToPublic(user),
    device: {
      id: tempDeviceId,
      name: 'Pending Registration',
      platform: 'macos',
      appVersion: '1.0.0',
      authPublicKey: '',
      linkedAt: now
    },
    isNewUser: isNew
  }

  return c.json(response)
})

// =============================================================================
// Device Registration
// =============================================================================

/**
 * T050, T050a, T050b: POST /auth/devices
 * Register a new device with challenge/response.
 */
authRoutes.post('/devices', authMiddleware(), async (c) => {
  const auth = getAuth(c)
  const body = await c.req.json()
  const parsed = DeviceRegisterRequestSchema.safeParse(body)

  if (!parsed.success) {
    throw validationError('Invalid request', { issues: parsed.error.issues })
  }

  const {
    name,
    platform,
    osVersion,
    appVersion,
    authPublicKey,
    challengeSignature,
    challengeNonce
  } = parsed.data

  const isValid = await verifyDeviceChallenge(authPublicKey, challengeNonce, challengeSignature)

  if (!isValid) {
    throw new SyncError(
      'Invalid device challenge signature',
      ErrorCode.CRYPTO_INVALID_SIGNATURE,
      400
    )
  }

  const deviceId = auth.deviceId
  const now = Date.now()

  const existingDevice = await c.env.DB.prepare(
    `SELECT id, auth_public_key
     FROM devices
     WHERE id = ?`
  )
    .bind(deviceId)
    .first<{ id: string; auth_public_key: string | null }>()

  if (existingDevice) {
    if (existingDevice.auth_public_key && existingDevice.auth_public_key !== authPublicKey) {
      throw badRequest('Device already registered')
    }

    await c.env.DB.prepare(
      `UPDATE devices
       SET name = ?, platform = ?, os_version = ?, app_version = ?, auth_public_key = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(name, platform, osVersion ?? null, appVersion, authPublicKey, now, deviceId)
      .run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO devices (id, user_id, name, platform, os_version, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        deviceId,
        auth.userId,
        name,
        platform,
        osVersion ?? null,
        appVersion,
        authPublicKey,
        now,
        now
      )
      .run()
  }

  const newChallenge = crypto.randomUUID()

  const device: Device = {
    id: deviceId,
    userId: auth.userId,
    name,
    platform: platform as DevicePlatform,
    osVersion,
    appVersion,
    authPublicKey,
    linkedAt: now
  }

  const response: DeviceRegisterResponse = {
    device,
    challenge: newChallenge
  }

  return c.json(response)
})

/**
 * GET /auth/devices
 * Get all devices for the authenticated user.
 * Returns devices with their public keys so new devices can verify signatures.
 */
authRoutes.get('/devices', authMiddleware(), async (c) => {
  const auth = getAuth(c)
  const devices = await getDevicesByUserId(c.env.DB, auth.userId)
  return c.json({ devices })
})

// =============================================================================
// First Device Setup
// =============================================================================

/**
 * T051: POST /auth/setup
 * Complete first device setup with recovery phrase derived keys.
 */
authRoutes.post('/setup', authMiddleware(), async (c) => {
  const auth = getAuth(c)
  const body = await c.req.json()
  const parsed = FirstDeviceSetupRequestSchema.safeParse(body)

  if (!parsed.success) {
    throw validationError('Invalid request', { issues: parsed.error.issues })
  }

  const { kdfSalt, keyVerifier } = parsed.data

  const user = await getUserById(c.env.DB, auth.userId)

  if (!user) {
    throw notFound('User')
  }

  if (user.kdfSalt && user.keyVerifier) {
    throw badRequest('First device setup already completed')
  }

  await updateUser(c.env.DB, auth.userId, {
    kdfSalt,
    keyVerifier
  })

  const response: FirstDeviceSetupResponse = {
    success: true
  }

  return c.json(response)
})

// =============================================================================
// Token Refresh
// =============================================================================

/**
 * T052b: POST /auth/refresh
 * Refresh access token.
 * Token rotation has built-in replay protection via the rotateRefreshToken function.
 */
authRoutes.post('/refresh', async (c) => {
  const body = await c.req.json()
  const parsed = RefreshTokenRequestSchema.safeParse(body)

  if (!parsed.success) {
    throw validationError('Invalid request', { issues: parsed.error.issues })
  }

  const { refreshToken } = parsed.data

  const result = await rotateRefreshToken(c.env.DB, refreshToken, c.env.JWT_SECRET)

  const response: RefreshTokenResponse = {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken
  }

  return c.json(response)
})

// =============================================================================
// Recovery Endpoints
// =============================================================================

/**
 * GET /auth/recovery
 * Get recovery info (kdfSalt and keyVerifier for master key derivation)
 */
authRoutes.get('/recovery', authMiddleware(), async (c) => {
  const auth = getAuth(c)

  const user = await getUserById(c.env.DB, auth.userId)

  if (!user) {
    throw notFound('User')
  }

  if (!user.kdfSalt || !user.keyVerifier) {
    throw notFound('Recovery info not set up. Please complete first device setup.')
  }

  const response: RecoveryInfoResponse = {
    kdfSalt: user.kdfSalt,
    keyVerifier: user.keyVerifier
  }

  return c.json(response)
})

// =============================================================================
// Logout
// =============================================================================

/**
 * POST /auth/logout
 * Logout and revoke tokens
 */
authRoutes.post('/logout', authMiddleware(), async (c) => {
  const auth = getAuth(c)
  const body = await c.req.json().catch(() => ({}))
  const parsed = LogoutRequestSchema.safeParse(body)

  if (!parsed.success) {
    throw validationError('Invalid request', { issues: parsed.error.issues })
  }

  const { refreshToken, allDevices } = parsed.data

  if (allDevices) {
    await c.env.DB.prepare(`DELETE FROM refresh_tokens WHERE user_id = ?`).bind(auth.userId).run()
  } else if (refreshToken) {
    const tokenHash = await hashToken(refreshToken)
    await c.env.DB.prepare(`DELETE FROM refresh_tokens WHERE token_hash = ? AND user_id = ?`)
      .bind(tokenHash, auth.userId)
      .run()
  } else {
    await c.env.DB.prepare(`DELETE FROM refresh_tokens WHERE device_id = ? AND user_id = ?`)
      .bind(auth.deviceId, auth.userId)
      .run()
  }

  const response: LogoutResponse = {
    success: true
  }

  return c.json(response)
})

// =============================================================================
// Device Linking Endpoints
// =============================================================================

/**
 * T104: POST /auth/linking/initiate
 * Start device linking from existing device.
 * Creates a linking session and returns QR payload for the new device.
 */
authRoutes.post('/linking/initiate', authMiddleware(), async (c) => {
  const auth = getAuth(c)
  const body = await c.req.json()
  const parsed = LinkingInitiateRequestSchema.safeParse(body)

  if (!parsed.success) {
    throw validationError('Invalid request', { issues: parsed.error.issues })
  }

  const { deviceId, ephemeralPublicKey } = parsed.data

  const rateKey = `linking_operation:${auth.userId}`
  const rateCheck = await checkRateLimit(
    c.env.DB,
    rateKey,
    RATE_LIMITS.linking_operation.requests,
    RATE_LIMITS.linking_operation.windowMs
  )

  if (!rateCheck.allowed) {
    const retryAfter = Math.ceil((rateCheck.resetAt - Date.now()) / 1000)
    c.header('Retry-After', String(retryAfter))
    throw new SyncError('Too many linking requests', ErrorCode.AUTH_RATE_LIMITED, 429, { retryAfter })
  }

  const ownsDevice = await verifyDeviceOwnership(c.env.DB, deviceId, auth.userId)
  if (!ownsDevice) {
    throw linkingDeviceNotOwned()
  }
  const linkingToken = generateLinkingToken()
  const linkingTokenHash = await hashLinkingToken(linkingToken)
  const sessionId = crypto.randomUUID()
  const expiresAt = calculateSessionExpiry()

  await createLinkingSession(c.env.DB, {
    id: sessionId,
    userId: auth.userId,
    initiatorDeviceId: deviceId,
    ephemeralPublicKey,
    linkingTokenHash,
    expiresAt
  })

  const serverUrl = new URL(c.req.url).origin
  const qrPayload = encodeQRPayload({
    sessionId,
    token: linkingToken,
    ephemeralPublicKey,
    serverUrl
  })

  const doId = c.env.LINKING_SESSION.idFromName(sessionId)
  const stub = c.env.LINKING_SESSION.get(doId)
  await stub.fetch(new Request('https://internal/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      userId: auth.userId,
      expiresAt
    })
  }))

  const response: LinkingInitiateResponse = {
    sessionId,
    ephemeralPublicKey,
    qrPayload,
    expiresAt
  }

  return c.json(response)
})

/**
 * T105: POST /auth/linking/scan
 * New device scans QR code and submits its public key.
 * No auth required - new device doesn't have tokens yet.
 */
authRoutes.post('/linking/scan', async (c) => {
  const body = await c.req.json()
  const parsed = LinkingScanRequestSchema.safeParse(body)

  if (!parsed.success) {
    throw validationError('Invalid request', { issues: parsed.error.issues })
  }

  const { sessionId, token, newDevicePublicKey, newDeviceConfirm } = parsed.data

  const rateKey = `linking_scan:${sessionId}`
  const rateCheck = await checkRateLimit(
    c.env.DB,
    rateKey,
    RATE_LIMITS.linking_scan.requests,
    RATE_LIMITS.linking_scan.windowMs
  )

  if (!rateCheck.allowed) {
    const retryAfter = Math.ceil((rateCheck.resetAt - Date.now()) / 1000)
    c.header('Retry-After', String(retryAfter))
    throw new SyncError('Too many scan attempts', ErrorCode.AUTH_RATE_LIMITED, 429, { retryAfter })
  }

  const session = await getLinkingSession(c.env.DB, sessionId)
  if (!session) {
    throw linkingSessionNotFound()
  }

  if (isSessionExpired(session.expires_at)) {
    throw linkingSessionExpired()
  }

  const tokenValid = await verifyLinkingToken(token, session.linking_token_hash)
  if (!tokenValid) {
    throw badRequest('Invalid linking token')
  }

  const updated = await updateSessionToScanned(c.env.DB, sessionId, newDevicePublicKey, newDeviceConfirm)
  if (!updated) {
    throw linkingInvalidState('pending', session.status)
  }

  const doId = c.env.LINKING_SESSION.idFromName(sessionId)
  const stub = c.env.LINKING_SESSION.get(doId)
  await stub.fetch(new Request('https://internal/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'scanned' })
  }))

  const response: LinkingScanResponse = {
    status: 'scanned'
  }

  return c.json(response)
})

/**
 * T106: POST /auth/linking/approve
 * Existing device approves and transfers encrypted master key.
 */
authRoutes.post('/linking/approve', authMiddleware(), async (c) => {
  const auth = getAuth(c)
  const body = await c.req.json()
  const parsed = LinkingApproveRequestSchema.safeParse(body)

  if (!parsed.success) {
    throw validationError('Invalid request', { issues: parsed.error.issues })
  }

  const { sessionId, encryptedMasterKey, encryptedKeyNonce, keyConfirm } = parsed.data

  const session = await getLinkingSession(c.env.DB, sessionId)
  if (!session) {
    throw linkingSessionNotFound()
  }

  if (session.user_id !== auth.userId) {
    throw linkingDeviceNotOwned()
  }

  if (isSessionExpired(session.expires_at)) {
    throw linkingSessionExpired()
  }

  const updated = await updateSessionToApproved(c.env.DB, sessionId, encryptedMasterKey, encryptedKeyNonce, keyConfirm)
  if (!updated) {
    throw linkingInvalidState('scanned', session.status)
  }

  const doId = c.env.LINKING_SESSION.idFromName(sessionId)
  const stub = c.env.LINKING_SESSION.get(doId)
  await stub.fetch(new Request('https://internal/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved' })
  }))

  const response: LinkingApproveResponse = {
    status: 'approved'
  }

  return c.json(response)
})

/**
 * GET /auth/linking/:sessionId
 * Get linking session status.
 * Supports two auth methods:
 * - JWT Bearer token (for initiator device)
 * - Linking token in query param ?token=xxx (for new device)
 */
authRoutes.get('/linking/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const tokenQuery = c.req.query('token')

  const session = await getLinkingSession(c.env.DB, sessionId)
  if (!session) {
    throw linkingSessionNotFound()
  }

  if (isSessionExpired(session.expires_at)) {
    throw linkingSessionExpired()
  }

  const authHeader = c.req.header('Authorization')
  let isAuthorized = false

  if (authHeader?.startsWith('Bearer ')) {
    try {
      const auth = getAuth(c)
      if (auth?.userId === session.user_id) {
        isAuthorized = true
      }
    } catch {
      // JWT validation failed, check for token auth
    }
  }

  if (!isAuthorized && tokenQuery) {
    const tokenValid = await verifyLinkingToken(tokenQuery, session.linking_token_hash)
    if (tokenValid) {
      isAuthorized = true
    }
  }

  if (!isAuthorized) {
    throw new SyncError('Unauthorized', ErrorCode.AUTH_UNAUTHORIZED, 401)
  }

  return c.json({
    id: session.id,
    initiatorDeviceId: session.initiator_device_id,
    ephemeralPublicKey: session.ephemeral_public_key,
    newDevicePublicKey: session.new_device_public_key ?? undefined,
    status: session.status,
    createdAt: session.created_at,
    expiresAt: session.expires_at,
    completedAt: session.completed_at ?? undefined
  })
})

/**
 * T107: POST /auth/linking/complete
 * New device completes linking and retrieves encrypted master key.
 * No auth required - new device doesn't have tokens yet.
 */
authRoutes.post('/linking/complete', async (c) => {
  const body = await c.req.json()
  const parsed = LinkingCompleteRequestSchema.safeParse(body)

  if (!parsed.success) {
    throw validationError('Invalid request', { issues: parsed.error.issues })
  }

  const { sessionId, token, newDeviceConfirm } = parsed.data

  const rateKey = `linking_complete:${sessionId}`
  const rateCheck = await checkRateLimit(
    c.env.DB,
    rateKey,
    RATE_LIMITS.linking_complete.requests,
    RATE_LIMITS.linking_complete.windowMs
  )

  if (!rateCheck.allowed) {
    const retryAfter = Math.ceil((rateCheck.resetAt - Date.now()) / 1000)
    c.header('Retry-After', String(retryAfter))
    throw new SyncError('Too many complete attempts', ErrorCode.AUTH_RATE_LIMITED, 429, { retryAfter })
  }

  const session = await getLinkingSession(c.env.DB, sessionId)
  if (!session) {
    throw linkingSessionNotFound()
  }

  if (isSessionExpired(session.expires_at)) {
    throw linkingSessionExpired()
  }

  const tokenValid = await verifyLinkingToken(token, session.linking_token_hash)
  if (!tokenValid) {
    throw badRequest('Invalid linking token')
  }

  if (session.new_device_confirm !== newDeviceConfirm) {
    throw linkingConfirmMismatch()
  }

  if (!session.encrypted_master_key || !session.encrypted_key_nonce || !session.key_confirm) {
    throw linkingSessionIncomplete()
  }

  const now = Date.now()
  const deviceId = await ensurePendingDevice(c.env.DB, session.user_id, now)

  const tokens = await issueTokenPair(c.env.DB, session.user_id, deviceId, c.env.JWT_SECRET)

  const updated = await updateSessionToCompleted(c.env.DB, sessionId)
  if (!updated) {
    throw linkingInvalidState('approved', session.status)
  }

  const doId = c.env.LINKING_SESSION.idFromName(sessionId)
  const stub = c.env.LINKING_SESSION.get(doId)
  await stub.fetch(new Request('https://internal/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'completed' })
  }))

  const response: LinkingCompleteResponse = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    encryptedMasterKey: session.encrypted_master_key,
    encryptedKeyNonce: session.encrypted_key_nonce,
    keyConfirm: session.key_confirm,
    device: {
      id: deviceId,
      userId: session.user_id,
      name: 'Pending Registration',
      platform: 'unknown',
      appVersion: '0.0.0',
      authPublicKey: '',
      linkedAt: now
    }
  }

  return c.json(response)
})

// =============================================================================
// Helper Functions
// =============================================================================

function generateCodeVerifier(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return base64UrlEncode(array)
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(new Uint8Array(hash))
}

function base64UrlEncode(buffer: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

interface GoogleAuthParams {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}

function buildGoogleAuthUrl(params: GoogleAuthParams): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'email profile')
  url.searchParams.set('state', params.state)
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

interface ExchangeParams {
  code: string
  codeVerifier: string
  redirectUri: string
  clientId: string
  clientSecret: string
}

interface GoogleTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  scope: string
  id_token?: string
}

async function exchangeGoogleCode(params: ExchangeParams): Promise<GoogleTokenResponse> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: params.codeVerifier
    })
  })

  if (!response.ok) {
    const error = await response.text()
    throw new SyncError(`Failed to exchange OAuth code: ${error}`, ErrorCode.AUTH_UNAUTHORIZED, 401)
  }

  return response.json()
}

interface GoogleUserInfo {
  id: string
  email: string
  verified_email: boolean
  name?: string
  picture?: string
}

async function getGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })

  if (!response.ok) {
    throw new SyncError('Failed to get user info from Google', ErrorCode.AUTH_UNAUTHORIZED, 401)
  }

  return response.json()
}

async function verifyDeviceChallenge(
  publicKeyBase64: string,
  nonceBase64: string,
  signatureBase64: string
): Promise<boolean> {
  try {
    const publicKeyBytes = Uint8Array.from(atob(publicKeyBase64), (c) => c.charCodeAt(0))
    const nonceBytes = Uint8Array.from(atob(nonceBase64), (c) => c.charCodeAt(0))
    const signatureBytes = Uint8Array.from(atob(signatureBase64), (c) => c.charCodeAt(0))

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify']
    )

    return await crypto.subtle.verify('Ed25519', cryptoKey, signatureBytes, nonceBytes)
  } catch (error) {
    console.error('Failed to verify device challenge:', error)
    return false
  }
}

async function ensurePendingDevice(db: D1Database, userId: string, now: number): Promise<string> {
  const existingPending = await db
    .prepare(
      `SELECT id
       FROM devices
       WHERE user_id = ? AND auth_public_key = ?`
    )
    .bind(userId, '')
    .first<{ id: string }>()

  if (existingPending?.id) {
    await db
      .prepare(`UPDATE devices SET updated_at = ? WHERE id = ?`)
      .bind(now, existingPending.id)
      .run()
    return existingPending.id
  }

  const deviceId = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, os_version, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(deviceId, userId, 'Pending Registration', 'unknown', null, '0.0.0', '', now, now)
    .run()

  return deviceId
}

export { authRoutes }
