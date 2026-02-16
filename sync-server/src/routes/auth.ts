import { Hono } from 'hono'
import { jwtVerify, createRemoteJWKSet, SignJWT } from 'jose'

import {
  RequestOtpRequestSchema,
  VerifyOtpRequestSchema,
  DeviceRegisterRequestSchema,
  FirstDeviceSetupRequestSchema,
  RefreshTokenRequestSchema,
  OAuthCallbackSchema
} from '../contracts/auth-api'
import { buildOtpEmailHtml } from '../emails/otp-template'
import { safeBase64Decode } from '../lib/encoding'
import { AppError, ErrorCodes } from '../lib/errors'
import { getPrivateKey, getPublicKey } from '../lib/jwt-keys'
import { authMiddleware } from '../middleware/auth'
import { createRateLimiter } from '../middleware/rate-limit'
import { setupAuthMiddleware } from '../middleware/setup-auth'
import { issueTokens, rotateRefreshToken, signSetupToken } from '../services/auth'
import { listDevices } from '../services/device'
import { sendEmail } from '../services/email'
import {
  generateOtp,
  storeOtp,
  verifyOtp,
  checkEmailRateLimit,
  hasPendingOtp
} from '../services/otp'
import { getOrCreateUserByEmail, getUserById, updateUser } from '../services/user'
import type { AppContext } from '../types'

const OTP_EXPIRY_MINUTES = 10

const otpIpRateLimit = createRateLimiter({
  maxRequests: 10,
  windowSeconds: 3600,
  keyPrefix: 'otp-ip'
})

const refreshRateLimit = createRateLimiter({
  maxRequests: 30,
  windowSeconds: 60,
  keyPrefix: 'refresh'
})

const handleOtpRequest = async (c: Parameters<typeof otpIpRateLimit>[0]): Promise<Response> => {
  const body = await c.req.json()
  const parsed = RequestOtpRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const { email } = parsed.data

  await checkEmailRateLimit(c.env.DB, email)

  const code = generateOtp()
  await storeOtp(c.env.DB, email, code)

  const html = buildOtpEmailHtml(code, OTP_EXPIRY_MINUTES)
  await sendEmail(email, 'Your Memry verification code', html, c.env.RESEND_API_KEY)

  return c.json({ success: true, expiresIn: OTP_EXPIRY_MINUTES * 60 })
}

const validateGoogleIdToken = async (
  idToken: string,
  expectedClientId: string
): Promise<{ email: string; sub: string; name?: string }> => {
  const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))

  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: expectedClientId
  })

  if (!payload.email || payload.email_verified !== true) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Google account email not verified', 401)
  }

  return {
    email: payload.email as string,
    sub: payload.sub as string,
    name: payload.name as string | undefined
  }
}

const verifyDeviceChallenge = async (
  publicKeyBase64: string,
  challengePayload: string,
  signatureBase64: string
): Promise<boolean> => {
  const keyBytes = safeBase64Decode(publicKeyBase64)
  const sigBytes = safeBase64Decode(signatureBase64)
  const payloadBytes = new TextEncoder().encode(challengePayload)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'Ed25519', namedCurve: 'Ed25519' },
    false,
    ['verify']
  )

  return crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, payloadBytes)
}

const OAUTH_STATE_EXPIRY = '5m'

export const generateOAuthState = async (
  privateKeyPem: string,
  redirectUri?: string
): Promise<string> => {
  const privateKey = await getPrivateKey(privateKeyPem)
  const claims: Record<string, unknown> = { type: 'oauth_state', nonce: crypto.randomUUID() }
  if (redirectUri) {
    claims.redirect_uri = redirectUri
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt()
    .setIssuer('memry-sync')
    .setAudience('memry-client')
    .setExpirationTime(OAUTH_STATE_EXPIRY)
    .sign(privateKey)
}

export const verifyOAuthState = async (
  state: string,
  publicKeyPem: string
): Promise<{ redirectUri?: string }> => {
  const publicKey = await getPublicKey(publicKeyPem)
  const { payload } = await jwtVerify(state, publicKey, {
    algorithms: ['EdDSA'],
    issuer: 'memry-sync',
    audience: 'memry-client'
  })
  if (payload.type !== 'oauth_state') {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Invalid OAuth state token type', 401)
  }
  return { redirectUri: payload.redirect_uri as string | undefined }
}

export const auth = new Hono<AppContext>()

// POST /otp/request
auth.post('/otp/request', otpIpRateLimit, async (c) => {
  return handleOtpRequest(c)
})

// POST /otp/resend
auth.post('/otp/resend', otpIpRateLimit, async (c) => {
  const body = await c.req.json()
  const parsed = RequestOtpRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const { email } = parsed.data

  const pending = await hasPendingOtp(c.env.DB, email)
  if (!pending) {
    return c.json({ success: true, expiresIn: OTP_EXPIRY_MINUTES * 60 })
  }

  await checkEmailRateLimit(c.env.DB, email)

  const code = generateOtp()
  await storeOtp(c.env.DB, email, code)

  const html = buildOtpEmailHtml(code, OTP_EXPIRY_MINUTES)
  await sendEmail(email, 'Your Memry verification code', html, c.env.RESEND_API_KEY)

  return c.json({ success: true, expiresIn: OTP_EXPIRY_MINUTES * 60 })
})

// POST /otp/verify
auth.post('/otp/verify', otpIpRateLimit, async (c) => {
  const body = await c.req.json()
  const parsed = VerifyOtpRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const { email, code, sessionNonce } = parsed.data

  await verifyOtp(c.env.DB, email, code)

  const { user, isNewUser } = await getOrCreateUserByEmail(c.env.DB, email, {
    authMethod: 'otp'
  })

  await updateUser(c.env.DB, user.id, { email_verified: 1 })

  const setupToken = await signSetupToken(user.id, c.env.JWT_PRIVATE_KEY, sessionNonce)

  return c.json({
    success: true,
    isNewUser,
    needsSetup: !user.kdf_salt,
    setupToken
  })
})

// GET /oauth/:provider
auth.get('/oauth/:provider', async (c) => {
  const provider = c.req.param('provider')
  if (provider !== 'google') {
    throw new AppError(ErrorCodes.AUTH_INVALID_PROVIDER, 'Unsupported OAuth provider', 400)
  }

  const clientRedirectUri = c.req.query('redirect_uri')
  const redirectUri = clientRedirectUri ?? c.env.GOOGLE_REDIRECT_URI

  if (clientRedirectUri && !/^http:\/\/127\.0\.0\.1(:\d+)?(\/.*)?$/.test(clientRedirectUri)) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'redirect_uri must be a 127.0.0.1 loopback address',
      400
    )
  }

  const state = await generateOAuthState(c.env.JWT_PRIVATE_KEY, redirectUri)

  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    state
  })

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
})

// POST /oauth/:provider/callback
auth.post('/oauth/:provider/callback', async (c) => {
  const provider = c.req.param('provider')
  if (provider !== 'google') {
    throw new AppError(ErrorCodes.AUTH_INVALID_PROVIDER, 'Unsupported OAuth provider', 400)
  }

  const body = await c.req.json()
  const parsed = OAuthCallbackSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid callback body', 400)
  }

  const { code, state, sessionNonce } = parsed.data

  const statePayload = await verifyOAuthState(state, c.env.JWT_PUBLIC_KEY)
  const redirectUri = statePayload.redirectUri ?? c.env.GOOGLE_REDIRECT_URI

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  })

  if (!tokenResponse.ok) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Failed to exchange authorization code', 401)
  }

  const tokenData = (await tokenResponse.json()) as { id_token?: string }
  if (!tokenData.id_token) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'No ID token in response', 401)
  }

  const claims = await validateGoogleIdToken(tokenData.id_token, c.env.GOOGLE_CLIENT_ID)

  const { user, isNewUser } = await getOrCreateUserByEmail(c.env.DB, claims.email, {
    authMethod: 'oauth',
    authProvider: 'google',
    authProviderId: claims.sub
  })

  const setupToken = await signSetupToken(user.id, c.env.JWT_PRIVATE_KEY, sessionNonce)

  return c.json({
    success: true,
    isNewUser,
    needsSetup: !user.kdf_salt,
    setupToken
  })
})

// POST /devices
auth.post('/devices', setupAuthMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = DeviceRegisterRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const userId = c.get('userId')!
  const tokenJti = c.get('tokenJti')!

  const consumeResult = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO consumed_setup_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)'
  )
    .bind(tokenJti, userId, Math.floor(Date.now() / 1000) + 300)
    .run()

  if ((consumeResult.meta.changes ?? 0) === 0) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Setup token already used', 401)
  }

  const activeDeviceCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM devices WHERE user_id = ? AND revoked_at IS NULL'
  )
    .bind(userId)
    .first<{ cnt: number }>()

  if (activeDeviceCount && activeDeviceCount.cnt >= 10) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'Maximum device limit reached. Revoke an existing device first.',
      409
    )
  }

  const {
    name,
    platform,
    osVersion,
    appVersion,
    authPublicKey,
    challengeSignature,
    challengeNonce,
    sessionNonce
  } = parsed.data

  const tokenSessionNonce = c.get('sessionNonce')
  if (tokenSessionNonce && tokenSessionNonce !== sessionNonce) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Session nonce mismatch', 401)
  }

  const challengePayload = `${challengeNonce}:${tokenJti}`
  const isValid = await verifyDeviceChallenge(authPublicKey, challengePayload, challengeSignature)
  if (!isValid) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Device challenge verification failed', 401)
  }

  const deviceId = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)

  await c.env.DB.prepare(
    `INSERT INTO devices (id, user_id, name, platform, os_version, app_version, auth_public_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(deviceId, userId, name, platform, osVersion ?? null, appVersion, authPublicKey, now, now)
    .run()

  const { accessToken, refreshToken } = await issueTokens(
    c.env.DB,
    userId,
    deviceId,
    c.env.JWT_PRIVATE_KEY
  )

  return c.json({
    success: true,
    deviceId,
    accessToken,
    refreshToken
  })
})

// GET /recovery-info
auth.get('/recovery-info', setupAuthMiddleware, async (c) => {
  const userId = c.get('userId')!

  const user = await getUserById(c.env.DB, userId)
  if (!user) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'User not found', 404)
  }

  if (!user.kdf_salt) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'No encryption keys configured', 400)
  }

  return c.json({
    kdfSalt: user.kdf_salt,
    keyVerifier: user.key_verifier
  })
})

// POST /setup — requires authenticated device (access token). The kdf_salt null
// check ensures this can only succeed once per account, preventing race conditions.
auth.post('/setup', authMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = FirstDeviceSetupRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const userId = c.get('userId')!
  const { kdfSalt, keyVerifier } = parsed.data

  const result = await c.env.DB.prepare(
    'UPDATE users SET kdf_salt = ?, key_verifier = ?, updated_at = ? WHERE id = ? AND kdf_salt IS NULL'
  )
    .bind(kdfSalt, keyVerifier, Math.floor(Date.now() / 1000), userId)
    .run()

  if ((result.meta.changes ?? 0) === 0) {
    const user = await getUserById(c.env.DB, userId)
    if (!user) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'User not found', 404)
    }
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Device setup already completed', 409)
  }

  return c.json({ success: true })
})

// GET /devices — returns all non-revoked devices for the authenticated user
const devicesRateLimit = createRateLimiter({
  maxRequests: 30,
  windowSeconds: 60,
  keyPrefix: 'devices-list'
})

auth.get('/devices', authMiddleware, devicesRateLimit, async (c) => {
  const userId = c.get('userId')!
  const devices = await listDevices(c.env.DB, userId)

  return c.json({
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      signingPublicKey: d.auth_public_key,
      revokedAt: d.revoked_at
    }))
  })
})

// POST /refresh
auth.post('/refresh', refreshRateLimit, async (c) => {
  const body = await c.req.json()
  const parsed = RefreshTokenRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const { refreshToken } = parsed.data

  let claims: { sub?: string; device_id?: string; type?: string }
  try {
    const publicKey = await getPublicKey(c.env.JWT_PUBLIC_KEY)
    const result = await jwtVerify(refreshToken, publicKey, {
      algorithms: ['EdDSA'],
      issuer: 'memry-sync',
      audience: 'memry-client'
    })
    claims = result.payload as typeof claims
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token verification failed'
    if (message.includes('expired')) {
      throw new AppError(ErrorCodes.AUTH_TOKEN_EXPIRED, 'Refresh token has expired', 401)
    }
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Invalid refresh token', 401)
  }

  if (claims.type !== 'refresh' || !claims.sub || !claims.device_id) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Invalid refresh token claims', 401)
  }

  const tokens = await rotateRefreshToken(
    c.env.DB,
    refreshToken,
    claims.sub,
    claims.device_id,
    c.env.JWT_PRIVATE_KEY
  )

  return c.json({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: 900
  })
})
