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
  type OtpRequestResponse,
  type OtpVerifyResponse,
  type OtpResendResponse,
  type DeviceRegisterResponse,
  type RefreshTokenResponse,
  type FirstDeviceSetupResponse,
  type OAuthInitiateResponse,
  type OAuthCallbackResponse,
} from '../contracts/auth-api'
import type { Device, DevicePlatform } from '../contracts/sync-api'
import { createOtp, verifyOtp } from '../services/otp'
import {
  findOrCreateUserByEmail,
  getUserById,
  updateUser,
  userToPublic,
} from '../services/user'
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
  unauthorized,
} from '../lib/errors'

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
      fromName: c.env.EMAIL_FROM_NAME,
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
      expiresAt,
    }

    return c.json(response)
  }
)

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

  const tempDeviceId = crypto.randomUUID()

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
      linkedAt: Date.now(),
    },
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
      fromName: c.env.EMAIL_FROM_NAME,
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
      expiresAt,
    }

    return c.json(response)
  }
)

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

  const state = crypto.randomUUID()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)

  const redirectUri = `${c.req.url.split('/auth/')[0]}/auth/oauth/google/callback`

  const oauthState: OAuthState = {
    state,
    codeVerifier,
    redirectUri,
    createdAt: Date.now(),
  }

  const stateHash = await hashToken(state)
  await c.env.DB.prepare(
    `INSERT INTO oauth_states (id, state_hash, code_verifier, redirect_uri, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      stateHash,
      codeVerifier,
      redirectUri,
      oauthState.createdAt,
      oauthState.createdAt + AUTH_STATE_EXPIRY_MS
    )
    .run()

  const googleAuthUrl = buildGoogleAuthUrl({
    clientId: c.env.GOOGLE_CLIENT_ID,
    redirectUri,
    state,
    codeChallenge,
  })

  const response: OAuthInitiateResponse = {
    authUrl: googleAuthUrl,
    state,
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

  const { code, state, error, error_description } = parsed.data

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

  await c.env.DB.prepare(`DELETE FROM oauth_states WHERE id = ?`).bind(storedState.id).run()

  const tokenResponse = await exchangeGoogleCode({
    code,
    codeVerifier: storedState.code_verifier,
    redirectUri: storedState.redirect_uri,
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET,
  })

  const googleUser = await getGoogleUserInfo(tokenResponse.access_token)

  const { user, isNew } = await findOrCreateUserByEmail(
    c.env.DB,
    googleUser.email,
    'oauth',
    'google',
    googleUser.id
  )

  const tempDeviceId = crypto.randomUUID()

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
      linkedAt: Date.now(),
    },
    isNewUser: isNew,
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

  const { name, platform, osVersion, appVersion, authPublicKey, challengeSignature, challengeNonce } =
    parsed.data

  const isValid = await verifyDeviceChallenge(authPublicKey, challengeNonce, challengeSignature)

  if (!isValid) {
    throw new SyncError('Invalid device challenge signature', ErrorCode.CRYPTO_INVALID_SIGNATURE, 400)
  }

  const deviceId = crypto.randomUUID()
  const now = Date.now()

  await c.env.DB.prepare(
    `INSERT INTO devices (id, user_id, name, platform, os_version, app_version, auth_public_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(deviceId, auth.userId, name, platform, osVersion ?? null, appVersion, authPublicKey, now, now)
    .run()

  const newChallenge = crypto.randomUUID()

  const device: Device = {
    id: deviceId,
    userId: auth.userId,
    name,
    platform: platform as DevicePlatform,
    osVersion,
    appVersion,
    authPublicKey,
    linkedAt: now,
  }

  const response: DeviceRegisterResponse = {
    device,
    challenge: newChallenge,
  }

  return c.json(response)
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
    keyVerifier,
  })

  const response: FirstDeviceSetupResponse = {
    success: true,
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
      refreshToken: result.refreshToken,
    }

    return c.json(response)
  }
)

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
      code_verifier: params.codeVerifier,
    }),
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
    headers: { Authorization: `Bearer ${accessToken}` },
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

export { authRoutes }
