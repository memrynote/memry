import { Hono } from 'hono'
import { jwtVerify, createRemoteJWKSet, SignJWT } from 'jose'

import { z } from 'zod'

import {
  RequestOtpRequestSchema,
  VerifyOtpRequestSchema,
  DeviceRegisterRequestSchema,
  FirstDeviceSetupRequestSchema,
  RefreshTokenRequestSchema,
  OAuthCallbackSchema,
  RenewSetupTokenRequestSchema,
  EmailChangeRequestSchema,
  EmailChangeVerifySchema,
  DeleteAccountRequestSchema
} from '@memry/contracts/auth-api'
import { buildOtpEmailHtml } from '../emails/otp-template'
import { safeBase64Decode } from '../lib/encoding'
import { AppError, ErrorCodes } from '../lib/errors'
import { isJwtExpiredError } from '../lib/jwt-errors'
import { createLogger } from '../lib/logger'
import { getPrivateKey, getPublicKey } from '../lib/jwt-keys'
import { authMiddleware } from '../middleware/auth'
import { createRateLimiter } from '../middleware/rate-limit'
import { setupAuthMiddleware } from '../middleware/setup-auth'
import {
  issueTokens,
  revokeDeviceTokens,
  rotateRefreshToken,
  signSetupToken,
  verifyRenewableSetupToken
} from '../services/auth'
import { listDevices } from '../services/device'
import { sendEmail } from '../services/email'
import {
  generateOtp,
  storeOtp,
  verifyOtp,
  checkEmailRateLimit,
  hasPendingOtp
} from '../services/otp'
import {
  getOrCreateUserByEmail,
  getUserByEmail,
  getUserById,
  updateUser,
  updateUserEmail
} from '../services/user'
import { signCheckoutToken } from '../services/checkout-token'
import {
  createPaddlePortalSession,
  getBillingStatus,
  getPaddleInvoicePdfUrl,
  listPaddleInvoices,
  reconcilePaddleTransaction
} from '../services/paddle-billing'
import {
  ensureLocalAdminPaidSyncAccess,
  ensureLocalAdminPaidSyncAccessForUser
} from '../services/entitlements'
import { captureBusinessEvent, captureServerError, safeWaitUntil } from '../services/analytics'
import { deleteUserData } from '../services/account-deletion'
import type { AppContext, Bindings } from '../types'

const logger = createLogger('Auth')

const OTP_EXPIRY_MINUTES = 10
const DEVICE_TEXT_UNSAFE_CHARS = /[\u0000-\u001F\u007F<>"'`&]/g
const CHECKOUT_TOKEN_TTL_SECONDS = 10 * 60

const sanitizeDeviceText = (value: string, maxLength: number): string =>
  value.replace(DEVICE_TEXT_UNSAFE_CHARS, '').trim().slice(0, maxLength)

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

const recoveryIpRateLimit = createRateLimiter({
  maxRequests: 3,
  windowSeconds: 600,
  keyPrefix: 'recovery-ip'
})

// A legitimate setup renews at most a handful of times while its user hunts
// for a recovery phrase; this only exists to cap signature-probing.
const setupRenewRateLimit = createRateLimiter({
  maxRequests: 10,
  windowSeconds: 600,
  keyPrefix: 'setup-renew'
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
  await storeOtp(c.env.DB, email, code, c.env.OTP_HMAC_KEY)

  const html = buildOtpEmailHtml(code, OTP_EXPIRY_MINUTES)
  await sendEmail(
    email,
    'Your MemryNote verification code',
    html,
    c.env.RESEND_API_KEY,
    undefined,
    c.env
  )

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

const isLoopbackRedirect = (uri: string): boolean =>
  /^http:\/\/127\.0\.0\.1(:\d+)?(\/.*)?$/.test(uri)

// Google requires a "Desktop app" OAuth client for the 127.0.0.1 loopback the
// desktop app uses, and a "Web application" client for the site's https
// redirect. Same code path, different credential — pick by redirect type.
// Falls back to the web client when the desktop client isn't configured.
const resolveGoogleClient = (
  env: Bindings,
  redirectUri: string
): { clientId: string; clientSecret: string } => {
  if (
    isLoopbackRedirect(redirectUri) &&
    env.GOOGLE_DESKTOP_CLIENT_ID &&
    env.GOOGLE_DESKTOP_CLIENT_SECRET
  ) {
    return {
      clientId: env.GOOGLE_DESKTOP_CLIENT_ID,
      clientSecret: env.GOOGLE_DESKTOP_CLIENT_SECRET
    }
  }
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
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
  await storeOtp(c.env.DB, email, code, c.env.OTP_HMAC_KEY)

  const html = buildOtpEmailHtml(code, OTP_EXPIRY_MINUTES)
  await sendEmail(
    email,
    'Your MemryNote verification code',
    html,
    c.env.RESEND_API_KEY,
    undefined,
    c.env
  )

  return c.json({ success: true, expiresIn: OTP_EXPIRY_MINUTES * 60 })
})

// POST /otp/verify
auth.post('/otp/verify', otpIpRateLimit, async (c) => {
  const body = await c.req.json()
  const parsed = VerifyOtpRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const { email, code, sessionNonce, devicePublicKey } = parsed.data

  await verifyOtp(c.env.DB, email, code, c.env.OTP_HMAC_KEY)

  const { user, isNewUser } = await getOrCreateUserByEmail(c.env.DB, email, {
    authMethod: 'otp'
  })

  await updateUser(c.env.DB, user.id, { email_verified: 1 })
  await ensureLocalAdminPaidSyncAccess(
    c.env.DB,
    c.env.ENVIRONMENT,
    email,
    user.id,
    c.env.LOCAL_ADMIN_SYNC_EMAILS
  )

  const setupToken = await signSetupToken(user.id, c.env.JWT_PRIVATE_KEY, sessionNonce, {
    devicePublicKey
  })

  safeWaitUntil(
    c,
    captureBusinessEvent(c.env, isNewUser ? 'user_signed_up' : 'user_logged_in', user.id, {
      auth_method: 'otp'
    })
  )

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

  const isLoopback = clientRedirectUri != null && isLoopbackRedirect(clientRedirectUri)
  const isConfiguredWeb =
    clientRedirectUri != null && clientRedirectUri === c.env.WEB_OAUTH_REDIRECT_URI

  if (clientRedirectUri && !isLoopback && !isConfiguredWeb) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'redirect_uri must be a 127.0.0.1 loopback address or the configured web origin',
      400
    )
  }

  const state = await generateOAuthState(c.env.JWT_PRIVATE_KEY, redirectUri)
  const { clientId } = resolveGoogleClient(c.env, redirectUri)

  const params = new URLSearchParams({
    client_id: clientId,
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

  const { code, state, sessionNonce, devicePublicKey } = parsed.data

  const statePayload = await verifyOAuthState(state, c.env.JWT_PUBLIC_KEY)
  const redirectUri = statePayload.redirectUri ?? c.env.GOOGLE_REDIRECT_URI
  const { clientId, clientSecret } = resolveGoogleClient(c.env, redirectUri)

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
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

  const claims = await validateGoogleIdToken(tokenData.id_token, clientId)

  const { user, isNewUser } = await getOrCreateUserByEmail(c.env.DB, claims.email, {
    authMethod: 'oauth',
    authProvider: 'google',
    authProviderId: claims.sub
  })

  await ensureLocalAdminPaidSyncAccess(
    c.env.DB,
    c.env.ENVIRONMENT,
    claims.email,
    user.id,
    c.env.LOCAL_ADMIN_SYNC_EMAILS
  )

  const setupToken = await signSetupToken(user.id, c.env.JWT_PRIVATE_KEY, sessionNonce, {
    devicePublicKey
  })

  safeWaitUntil(
    c,
    captureBusinessEvent(c.env, isNewUser ? 'user_signed_up' : 'user_logged_in', user.id, {
      auth_method: 'oauth',
      auth_provider: 'google'
    })
  )

  return c.json({
    success: true,
    isNewUser,
    needsSetup: !user.kdf_salt,
    setupToken
  })
})

// POST /setup-token/renew
//
// #1202: the setup token is minted at sign-in but first used minutes later,
// once the user has found their 24-word recovery phrase. It sat idle for its
// whole 5-minute life and then died, stranding the reinstall.
//
// Renewal is deliberately NOT a bearer operation. It requires a signature from
// the device key the client committed at sign-in, so a setup token lifted from
// a log or an intercepted response is worth exactly the same five minutes it
// was worth before. Presenting a grant retires it, so only one setup token is
// ever redeemable, and `renewable_until` is signed into the grant at mint time
// so the chain cannot outlive its original window.
auth.post('/setup-token/renew', setupRenewRateLimit, async (c) => {
  const body = await c.req.json()
  const parsed = RenewSetupTokenRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const { setupToken, challengeNonce, challengeSignature } = parsed.data

  let publicKey: CryptoKey
  try {
    publicKey = await getPublicKey(c.env.JWT_PUBLIC_KEY)
  } catch {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Invalid JWT verify key configuration', 500)
  }

  const claims = await verifyRenewableSetupToken(setupToken, publicKey)

  const isValid = await verifyDeviceChallenge(
    claims.devicePublicKey,
    `${challengeNonce}:${claims.jti}`,
    challengeSignature
  )
  if (!isValid) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Device challenge verification failed', 401)
  }

  // Same single-use ledger POST /devices writes, so a renewed-away token can
  // never also register a device. expires_at is the chain deadline rather than
  // now+5m: cleanup must not drop the row while the chain is still alive, or
  // the retired jti would become renewable a second time.
  const consumed = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO consumed_setup_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)'
  )
    .bind(claims.jti, claims.userId, claims.renewableUntil)
    .run()

  if ((consumed.meta.changes ?? 0) === 0) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Setup token already used', 401)
  }

  const renewed = await signSetupToken(claims.userId, c.env.JWT_PRIVATE_KEY, claims.sessionNonce, {
    devicePublicKey: claims.devicePublicKey,
    renewableUntil: claims.renewableUntil
  })

  logger.info('Setup token renewed for an in-progress device setup', { userId: claims.userId })

  return c.json({ success: true, setupToken: renewed })
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

  const MAX_DEVICES_PER_USER = 50
  if (activeDeviceCount && activeDeviceCount.cnt >= MAX_DEVICES_PER_USER) {
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
    sessionNonce,
    vaultId
  } = parsed.data

  const sanitizedName = sanitizeDeviceText(name, 255)
  const sanitizedPlatform = sanitizeDeviceText(platform, 32)
  const sanitizedVaultId = sanitizeDeviceText(vaultId ?? 'default', 128)

  if (!sanitizedName || !sanitizedPlatform || !sanitizedVaultId) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid device metadata', 400)
  }

  const tokenSessionNonce = c.get('sessionNonce')
  if (tokenSessionNonce && tokenSessionNonce !== sessionNonce) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Session nonce mismatch', 401)
  }

  const challengePayload = `${challengeNonce}:${tokenJti}`
  const isValid = await verifyDeviceChallenge(authPublicKey, challengePayload, challengeSignature)
  if (!isValid) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Device challenge verification failed', 401)
  }

  const candidateDeviceId = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)

  const { results } = await c.env.DB.prepare(
    `INSERT INTO devices (id, user_id, name, platform, os_version, app_version, auth_public_key, vault_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, auth_public_key) DO UPDATE SET
       name = excluded.name,
       platform = excluded.platform,
       os_version = excluded.os_version,
       app_version = excluded.app_version,
       vault_id = excluded.vault_id,
       updated_at = excluded.updated_at
     RETURNING id`
  )
    .bind(
      candidateDeviceId,
      userId,
      sanitizedName,
      sanitizedPlatform,
      osVersion ?? null,
      appVersion,
      authPublicKey,
      sanitizedVaultId,
      now,
      now
    )
    .all()

  const deviceId = (results[0] as { id: string }).id

  const { accessToken, refreshToken } = await issueTokens(
    c.env.DB,
    userId,
    deviceId,
    c.env.JWT_PRIVATE_KEY
  )

  safeWaitUntil(
    c,
    captureBusinessEvent(c.env, 'device_registered', userId, {
      platform: sanitizedPlatform,
      app_version: appVersion
    })
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

// GET /key-verifier — same payload as /recovery-info but for an ESTABLISHED
// session (access token). Desktop uses it to check whether the locally stored
// master key still matches the account (vault-key mismatch detection); setup
// tokens are long gone by then, so /recovery-info cannot serve this case.
auth.get('/key-verifier', authMiddleware, async (c) => {
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

const RecoveryQuerySchema = z.object({ email: z.string().email() })
const BillingReconcileSchema = z.object({
  transactionId: z.string().trim().min(1).optional()
})

async function generateDummyRecoveryData(
  email: string,
  secret: string
): Promise<{ kdfSalt: string; keyVerifier: string }> {
  const encoder = new TextEncoder()
  const saltHash = await crypto.subtle.digest('SHA-256', encoder.encode(email + secret + 'salt'))
  const verifierHash = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(email + secret + 'verifier')
  )

  const saltBytes = new Uint8Array(saltHash).slice(0, 16)
  const verifierBytes = new Uint8Array(verifierHash)

  return {
    kdfSalt: btoa(String.fromCharCode(...saltBytes)),
    keyVerifier: btoa(String.fromCharCode(...verifierBytes))
  }
}

auth.get('/recovery', recoveryIpRateLimit, async (c) => {
  const parsed = RecoveryQuerySchema.safeParse({ email: c.req.query('email') })
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Valid email is required', 400)
  }

  // Anti-enumeration: always run BOTH the DB lookup and the dummy computation
  // regardless of whether the user exists, then select the response deterministically
  // with a single response shape. This keeps wall-clock timing and JSON serialization
  // side-channels identical between the "user exists" and "user does not exist" paths.
  const [user, dummy] = await Promise.all([
    getUserByEmail(c.env.DB, parsed.data.email),
    generateDummyRecoveryData(parsed.data.email, c.env.RECOVERY_DUMMY_SECRET)
  ])

  const hasRealRecovery = Boolean(user?.kdf_salt && user?.key_verifier)
  const response = {
    kdfSalt: hasRealRecovery ? (user!.kdf_salt as string) : dummy.kdfSalt,
    keyVerifier: hasRealRecovery ? (user!.key_verifier as string) : dummy.keyVerifier
  }
  return c.json(response)
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
  maxRequests: 60,
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

auth.post('/checkout-token', authMiddleware, async (c) => {
  const userId = c.get('userId')!
  const expiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_TOKEN_TTL_SECONDS
  const checkoutToken = await signCheckoutToken(c.env.PADDLE_CHECKOUT_TOKEN_SECRET, {
    userId,
    exp: expiresAt
  })

  return c.json({ checkoutToken, expiresAt })
})

auth.get('/billing', authMiddleware, async (c) => {
  const userId = c.get('userId')!
  await ensureLocalAdminPaidSyncAccessForUser(
    c.env.DB,
    c.env.ENVIRONMENT,
    userId,
    c.env.LOCAL_ADMIN_SYNC_EMAILS
  )
  return c.json(await getBillingStatus(c.env.DB, userId))
})

auth.post('/billing/reconcile', authMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = BillingReconcileSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid billing reconcile request', 400)
  }

  const userId = c.get('userId')!
  if (parsed.data.transactionId) {
    await reconcilePaddleTransaction(c.env, userId, parsed.data.transactionId)
  }
  await ensureLocalAdminPaidSyncAccessForUser(
    c.env.DB,
    c.env.ENVIRONMENT,
    userId,
    c.env.LOCAL_ADMIN_SYNC_EMAILS
  )

  return c.json(await getBillingStatus(c.env.DB, userId))
})

auth.post('/billing/portal-session', authMiddleware, async (c) => {
  const userId = c.get('userId')!
  return c.json(await createPaddlePortalSession(c.env, userId))
})

auth.get('/billing/invoices', authMiddleware, async (c) => {
  const userId = c.get('userId')!
  const invoices = await listPaddleInvoices(c.env, userId)
  return c.json({ invoices })
})

auth.get('/billing/invoices/:id/pdf', authMiddleware, async (c) => {
  const userId = c.get('userId')!
  const url = await getPaddleInvoicePdfUrl(c.env, userId, c.req.param('id'))
  return c.json({ url })
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
    if (isJwtExpiredError(err)) {
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

auth.post('/logout', authMiddleware, async (c) => {
  const deviceId = c.get('deviceId')!

  try {
    await revokeDeviceTokens(c.env.DB, deviceId)
  } catch (err) {
    // captureServerError logs + pushes to PostHog; logout still succeeds
    safeWaitUntil(
      c,
      captureServerError(c.env, {
        error: err,
        method: c.req.method,
        path: c.req.path,
        source: 'auth',
        action: 'logout_revoke_tokens',
        statusCode: 500,
        handled: true,
        userId: c.get('userId'),
        deviceId
      })
    )
  }

  return c.json({ success: true })
})

// POST /email/change — request OTP to new email address
auth.post('/email/change', authMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = EmailChangeRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }
  const { newEmail } = parsed.data
  const existing = await getUserByEmail(c.env.DB, newEmail)
  if (existing) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Email already in use', 409)
  }
  // Rate-limit per target address so this endpoint can't be used to bomb an
  // arbitrary inbox with "Confirm your new MemryNote email" messages (mirrors
  // /otp/request).
  await checkEmailRateLimit(c.env.DB, newEmail)
  const code = generateOtp()
  await storeOtp(c.env.DB, newEmail, code, c.env.OTP_HMAC_KEY)
  const html = buildOtpEmailHtml(code, OTP_EXPIRY_MINUTES)
  await sendEmail(
    newEmail,
    'Confirm your new MemryNote email',
    html,
    c.env.RESEND_API_KEY,
    undefined,
    c.env
  )
  return c.json({ success: true, expiresIn: OTP_EXPIRY_MINUTES * 60 })
})

// POST /email/change/verify — verify OTP and update email
auth.post('/email/change/verify', authMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = EmailChangeVerifySchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }
  const { newEmail, code } = parsed.data
  const existing = await getUserByEmail(c.env.DB, newEmail)
  if (existing) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Email already in use', 409)
  }
  await verifyOtp(c.env.DB, newEmail, code, c.env.OTP_HMAC_KEY)
  const userId = c.get('userId')!
  await updateUserEmail(c.env.DB, userId, newEmail)
  return c.json({ success: true })
})

// POST /logout-all — revoke all devices and refresh tokens for the authenticated user
auth.post('/logout-all', authMiddleware, async (c) => {
  const userId = c.get('userId')!
  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE devices SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL'
    ).bind(now, now, userId),
    c.env.DB.prepare(
      'UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0'
    ).bind(userId)
  ])
  return c.json({ success: true })
})

// DELETE /account — irreversibly delete the authenticated user's account after OTP verification
auth.delete('/account', authMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = DeleteAccountRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }
  const userId = c.get('userId')!
  const user = await getUserById(c.env.DB, userId)
  if (!user) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'User not found', 404)
  }
  await verifyOtp(c.env.DB, user.email, parsed.data.code, c.env.OTP_HMAC_KEY)
  await deleteUserData(c.env.DB, c.env.STORAGE, userId, user.email)
  return c.json({ success: true })
})
