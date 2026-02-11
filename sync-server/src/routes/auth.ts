import { Hono } from 'hono'
import { decodeJwt, jwtVerify, createRemoteJWKSet, SignJWT } from 'jose'

import {
  RequestOtpRequestSchema,
  VerifyOtpRequestSchema,
  DeviceRegisterRequestSchema,
  FirstDeviceSetupRequestSchema,
  RefreshTokenRequestSchema,
  OAuthCallbackSchema
} from '../contracts/auth-api'
import { buildOtpEmailHtml } from '../emails/otp-template'
import { AppError, ErrorCodes } from '../lib/errors'
import { getPrivateKey, getPublicKey } from '../lib/jwt-keys'
import { authMiddleware } from '../middleware/auth'
import { createRateLimiter } from '../middleware/rate-limit'
import { setupAuthMiddleware } from '../middleware/setup-auth'
import { issueTokens, rotateRefreshToken, signSetupToken } from '../services/auth'
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

// NOTE: The challenge nonce is client-generated rather than server-issued. The setup token
// (short-lived JWT from OTP/OAuth verification) already binds registration to an authenticated
// session. The challenge proves the client holds the private key for the submitted public key.
// Replay is mitigated by: (1) setup token 5-min expiry, (2) UNIQUE(user_id, auth_public_key)
// preventing duplicate registrations, (3) an attacker would need both a valid setup token AND
// a captured challenge triplet within the same expiry window.
const verifyDeviceChallenge = async (
  publicKeyBase64: string,
  nonce: string,
  signatureBase64: string
): Promise<boolean> => {
  const keyBytes = Uint8Array.from(atob(publicKeyBase64), (ch) => ch.charCodeAt(0))
  const sigBytes = Uint8Array.from(atob(signatureBase64), (ch) => ch.charCodeAt(0))
  const nonceBytes = new TextEncoder().encode(nonce)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'Ed25519', namedCurve: 'Ed25519' },
    false,
    ['verify']
  )

  return crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, nonceBytes)
}

const OAUTH_STATE_EXPIRY = '5m'

export const generateOAuthState = async (privateKeyPem: string): Promise<string> => {
  const privateKey = await getPrivateKey(privateKeyPem)
  return new SignJWT({ type: 'oauth_state', nonce: crypto.randomUUID() })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt()
    .setIssuer('memry-sync')
    .setAudience('memry-client')
    .setExpirationTime(OAUTH_STATE_EXPIRY)
    .sign(privateKey)
}

export const verifyOAuthState = async (state: string, publicKeyPem: string): Promise<void> => {
  const publicKey = await getPublicKey(publicKeyPem)
  const { payload } = await jwtVerify(state, publicKey, {
    algorithms: ['EdDSA'],
    issuer: 'memry-sync',
    audience: 'memry-client'
  })
  if (payload.type !== 'oauth_state') {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Invalid OAuth state token type', 401)
  }
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
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'No pending OTP for this email', 400)
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

  const { email, code } = parsed.data

  await verifyOtp(c.env.DB, email, code)

  const { user, isNewUser } = await getOrCreateUserByEmail(c.env.DB, email, {
    authMethod: 'otp'
  })

  await updateUser(c.env.DB, user.id, { email_verified: 1 })

  const setupToken = await signSetupToken(user.id, c.env.JWT_PRIVATE_KEY)

  return c.json({
    success: true,
    userId: user.id,
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

  const state = await generateOAuthState(c.env.JWT_PRIVATE_KEY)

  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: c.env.GOOGLE_REDIRECT_URI,
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

  const { code, state, redirectUri } = parsed.data

  await verifyOAuthState(state, c.env.JWT_PUBLIC_KEY)

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri ?? c.env.GOOGLE_REDIRECT_URI,
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

  const setupToken = await signSetupToken(user.id, c.env.JWT_PRIVATE_KEY)

  return c.json({
    success: true,
    userId: user.id,
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

// POST /setup
auth.post('/setup', authMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = FirstDeviceSetupRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const userId = c.get('userId')!
  const { kdfSalt, keyVerifier } = parsed.data

  const user = await getUserById(c.env.DB, userId)
  if (!user) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'User not found', 404)
  }

  if (user.kdf_salt) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Device setup already completed', 409)
  }

  await updateUser(c.env.DB, userId, { kdf_salt: kdfSalt, key_verifier: keyVerifier })

  return c.json({ success: true })
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
    claims = decodeJwt(refreshToken) as typeof claims
  } catch {
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
