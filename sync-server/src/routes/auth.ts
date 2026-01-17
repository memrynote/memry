/**
 * Auth Routes
 *
 * Handles authentication endpoints including:
 * - Email signup, verification, login
 * - Password forgot/reset/change
 * - OAuth initiation and callback
 * - Device registration
 * - First device setup
 *
 * @module routes/auth
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../index'
import { authMiddleware, verifyToken, type AuthContext } from '../middleware/auth'
import {
  createUser,
  getUserByEmail,
  getUserById,
  getUserByVerificationToken,
  getUserByResetToken,
  getUserByOAuthProvider,
  updateUser,
  setKdfSaltAndVerifier,
  type User
} from '../services/user'
import {
  validatePasswordStrength,
  assertValidPassword,
  hashPassword,
  verifyPassword,
  generateSecureToken,
  TOKEN_EXPIRY
} from '../services/password'
import { createAuthResult, refreshAccessToken } from '../services/auth'
import { registerDevice, toPublicDevice } from '../services/device'
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/email'
import {
  ValidationError,
  AuthenticationError,
  ConflictError,
  NotFoundError,
  LinkingSessionError
} from '../lib/errors'
import { generateTokens } from '../services/auth'
import { countActiveDevices } from '../services/device'
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit'

// =============================================================================
// Zod Schemas
// =============================================================================

const emailSchema = z.string().email().max(255)

const passwordSchema = z.string().min(12).max(128)

const emailSignupSchema = z.object({
  email: emailSchema,
  password: passwordSchema
})

const emailVerifySchema = z.object({
  token: z.string().min(1)
})

const emailLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1)
})

const forgotPasswordSchema = z.object({
  email: emailSchema
})

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  new_password: passwordSchema
})

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: passwordSchema
})

const resendVerificationSchema = z.object({
  email: emailSchema
})

const refreshTokenSchema = z.object({
  refresh_token: z.string().min(1)
})

const deviceRegistrationSchema = z.object({
  name: z.string().min(1).max(100),
  platform: z.enum(['macos', 'windows', 'linux', 'ios', 'android']),
  os_version: z.string().optional(),
  app_version: z.string().min(1),
  auth_public_key: z.string().optional()
})

const deviceSetupSchema = z.object({
  kdf_salt: z.string().min(1),
  key_verifier: z.string().min(1)
})

const oauthCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  code_verifier: z.string().min(1),
  redirect_uri: z.string().min(1)
})

// -----------------------------------------------------------------------------
// Device Linking Schemas (T104-T107)
// -----------------------------------------------------------------------------

const linkingInitiateSchema = z.object({
  ephemeral_public_key: z.string().min(1) // X25519 public key (Base64)
})

const linkingScanSchema = z.object({
  new_device_public_key: z.string().min(1), // X25519 public key (Base64)
  token: z.string().min(1), // One-time token from QR
  new_device_confirm: z.string().min(1), // HMAC proof (Base64)
  device_name: z.string().min(1).max(100).optional(), // Device name for registration
  device_platform: z.enum(['macos', 'windows', 'linux', 'ios', 'android']).optional() // Device platform
})

const linkingApproveSchema = z.object({
  encrypted_master_key: z.string().min(1), // Encrypted with ECDH shared secret (Base64)
  nonce: z.string().min(1), // Encryption nonce (Base64)
  key_confirm: z.string().min(1) // HMAC confirmation (Base64)
})

const linkingCompleteSchema = z.object({
  new_device_public_key: z.string().min(1) // X25519 public key for verification (Base64)
})

// =============================================================================
// Route Handlers
// =============================================================================

const auth = new Hono<{ Bindings: Env; Variables: { user: AuthContext } }>()

// -----------------------------------------------------------------------------
// Email Signup (T042)
// -----------------------------------------------------------------------------

auth.post('/email/signup', zValidator('json', emailSignupSchema), async (c) => {
  const { email, password } = c.req.valid('json')

  // Validate password strength
  assertValidPassword(password)

  // Check if email already exists
  const existingUser = await getUserByEmail(c.env.DB, email)
  if (existingUser) {
    throw new ConflictError('Email already registered')
  }

  // Hash password
  const { hash, salt } = await hashPassword(password)

  // Generate verification token
  const verificationToken = generateSecureToken()
  const verificationExpires = Date.now() + TOKEN_EXPIRY.EMAIL_VERIFICATION

  // Create user
  const user = await createUser(c.env.DB, {
    email,
    authMethod: 'email',
    passwordHash: hash,
    passwordSalt: salt,
    emailVerificationToken: verificationToken,
    emailVerificationExpires: verificationExpires
  })

  // Send verification email
  if (c.env.RESEND_API_KEY) {
    await sendVerificationEmail(email, verificationToken, c.env.RESEND_API_KEY)
  }

  return c.json(
    {
      message: 'Verification email sent',
      user_id: user.id
    },
    201
  )
})

// -----------------------------------------------------------------------------
// Email Verification (T043)
// -----------------------------------------------------------------------------

auth.post('/email/verify', zValidator('json', emailVerifySchema), async (c) => {
  const { token } = c.req.valid('json')

  // Find user by token
  const user = await getUserByVerificationToken(c.env.DB, token)
  if (!user) {
    throw new ValidationError('Invalid or expired verification token')
  }

  // Check token expiry
  if (user.email_verification_expires && user.email_verification_expires < Date.now()) {
    throw new ValidationError('Verification token has expired')
  }

  // Mark email as verified and clear token
  await updateUser(c.env.DB, user.id, {
    emailVerified: true,
    emailVerificationToken: null,
    emailVerificationExpires: null
  })

  // Register a temporary device for the auth result
  // The client will register the real device after setup
  const tempDeviceId = crypto.randomUUID()

  // Create auth result
  const result = await createAuthResult(
    { ...user, email_verified: 1 },
    tempDeviceId,
    c.env.JWT_SECRET,
    false
  )

  return c.json(result)
})

// -----------------------------------------------------------------------------
// Email Login (T044)
// -----------------------------------------------------------------------------

auth.post('/email/login', zValidator('json', emailLoginSchema), async (c) => {
  const { email, password } = c.req.valid('json')

  // Find user by email
  const user = await getUserByEmail(c.env.DB, email)
  if (!user) {
    throw new AuthenticationError('Invalid email or password')
  }

  // Check if email is verified
  if (!user.email_verified) {
    throw new AuthenticationError('Email not verified. Please check your inbox.')
  }

  // Verify password
  if (!user.password_hash || !user.password_salt) {
    throw new AuthenticationError('Invalid email or password')
  }

  const isValid = await verifyPassword(password, user.password_hash, user.password_salt)
  if (!isValid) {
    throw new AuthenticationError('Invalid email or password')
  }

  // Register a temporary device for the auth result
  // The client will register the real device after
  const tempDeviceId = crypto.randomUUID()

  // Create auth result
  const result = await createAuthResult(user, tempDeviceId, c.env.JWT_SECRET, false)

  return c.json(result)
})

// -----------------------------------------------------------------------------
// Forgot Password (T047a)
// -----------------------------------------------------------------------------

auth.post('/email/forgot-password', zValidator('json', forgotPasswordSchema), async (c) => {
  const { email } = c.req.valid('json')

  // Find user by email (silently succeed if not found to prevent enumeration)
  const user = await getUserByEmail(c.env.DB, email)

  if (user && user.auth_method === 'email') {
    // Generate reset token
    const resetToken = generateSecureToken()
    const resetExpires = Date.now() + TOKEN_EXPIRY.PASSWORD_RESET

    // Update user with reset token
    await updateUser(c.env.DB, user.id, {
      passwordResetToken: resetToken,
      passwordResetExpires: resetExpires
    })

    // Send password reset email
    if (c.env.RESEND_API_KEY) {
      await sendPasswordResetEmail(email, resetToken, c.env.RESEND_API_KEY)
    }
  }

  // Always return success to prevent email enumeration
  return c.json({
    message: 'If an account exists with this email, a password reset link has been sent'
  })
})

// -----------------------------------------------------------------------------
// Reset Password (T047b)
// -----------------------------------------------------------------------------

auth.post('/email/reset-password', zValidator('json', resetPasswordSchema), async (c) => {
  const { token, new_password } = c.req.valid('json')

  // Validate new password strength
  assertValidPassword(new_password)

  // Find user by reset token
  const user = await getUserByResetToken(c.env.DB, token)
  if (!user) {
    throw new ValidationError('Invalid or expired reset token')
  }

  // Check token expiry
  if (user.password_reset_expires && user.password_reset_expires < Date.now()) {
    throw new ValidationError('Reset token has expired')
  }

  // Hash new password
  const { hash, salt } = await hashPassword(new_password)

  // Update password and clear reset token
  await updateUser(c.env.DB, user.id, {
    passwordHash: hash,
    passwordSalt: salt,
    passwordResetToken: null,
    passwordResetExpires: null
  })

  return c.json({ message: 'Password has been reset successfully' })
})

// -----------------------------------------------------------------------------
// Change Password (T047c) - Authenticated
// -----------------------------------------------------------------------------

auth.post(
  '/email/change-password',
  authMiddleware,
  zValidator('json', changePasswordSchema),
  async (c) => {
    const { current_password, new_password } = c.req.valid('json')
    const authUser = c.get('user')

    // Validate new password strength
    assertValidPassword(new_password)

    // Get user from database
    const user = await getUserByEmail(c.env.DB, authUser.email)
    if (!user || !user.password_hash || !user.password_salt) {
      throw new AuthenticationError('Invalid credentials')
    }

    // Verify current password
    const isValid = await verifyPassword(current_password, user.password_hash, user.password_salt)
    if (!isValid) {
      throw new AuthenticationError('Current password is incorrect')
    }

    // Hash new password
    const { hash, salt } = await hashPassword(new_password)

    // Update password
    await updateUser(c.env.DB, user.id, {
      passwordHash: hash,
      passwordSalt: salt
    })

    return c.json({ message: 'Password changed successfully' })
  }
)

// -----------------------------------------------------------------------------
// Resend Verification (T047d)
// -----------------------------------------------------------------------------

auth.post('/email/resend-verification', zValidator('json', resendVerificationSchema), async (c) => {
  const { email } = c.req.valid('json')

  // Find user by email
  const user = await getUserByEmail(c.env.DB, email)

  // Only resend if user exists and is not yet verified
  if (user && !user.email_verified && user.auth_method === 'email') {
    // Generate new verification token
    const verificationToken = generateSecureToken()
    const verificationExpires = Date.now() + TOKEN_EXPIRY.EMAIL_VERIFICATION

    // Update user with new token
    await updateUser(c.env.DB, user.id, {
      emailVerificationToken: verificationToken,
      emailVerificationExpires: verificationExpires
    })

    // Send verification email
    if (c.env.RESEND_API_KEY) {
      await sendVerificationEmail(email, verificationToken, c.env.RESEND_API_KEY)
    }
  }

  // Always return success to prevent email enumeration
  return c.json({
    message: 'If an unverified account exists with this email, a verification link has been sent'
  })
})

// -----------------------------------------------------------------------------
// Token Refresh
// -----------------------------------------------------------------------------

auth.post('/refresh', zValidator('json', refreshTokenSchema), async (c) => {
  const { refresh_token } = c.req.valid('json')

  try {
    const { accessToken, expiresIn } = await refreshAccessToken(refresh_token, c.env.JWT_SECRET)

    return c.json({
      access_token: accessToken,
      expires_in: expiresIn
    })
  } catch {
    throw new AuthenticationError('Invalid or expired refresh token')
  }
})

// -----------------------------------------------------------------------------
// OAuth Initiation (T048)
// -----------------------------------------------------------------------------

auth.get('/oauth/:provider', async (c) => {
  const provider = c.req.param('provider')
  const redirectUri = c.req.query('redirect_uri')
  const state = c.req.query('state')
  const codeChallenge = c.req.query('code_challenge')
  const codeChallengeMethod = c.req.query('code_challenge_method')

  // Validate provider
  if (provider !== 'google') {
    throw new ValidationError(`Invalid OAuth provider: ${provider}`)
  }

  // Validate required params
  if (!redirectUri || !state || !codeChallenge || !codeChallengeMethod) {
    throw new ValidationError('Missing required OAuth parameters')
  }

  // Build authorization URL for Google
  const authUrl = buildGoogleAuthUrl(redirectUri, state, codeChallenge, c.env)

  // Redirect to provider
  return c.redirect(authUrl)
})

// -----------------------------------------------------------------------------
// OAuth Callback (T049)
// -----------------------------------------------------------------------------

auth.post('/oauth/:provider/callback', zValidator('json', oauthCallbackSchema), async (c) => {
  const provider = c.req.param('provider')
  const { code, state, code_verifier, redirect_uri } = c.req.valid('json')

  // Validate provider
  if (provider !== 'google') {
    throw new ValidationError(`Invalid OAuth provider: ${provider}`)
  }

  // Exchange code for tokens and get user profile
  const userProfile = await exchangeGoogleCode(code, code_verifier, redirect_uri, c.env)

  // Find or create user
  let user = await getUserByOAuthProvider(c.env.DB, provider, userProfile.providerId)
  let isNewUser = false

  if (!user) {
    // Check if email is already registered
    const existingUser = await getUserByEmail(c.env.DB, userProfile.email)
    if (existingUser) {
      throw new ConflictError('Email already registered with different auth method')
    }

    // Create new user
    user = await createUser(c.env.DB, {
      email: userProfile.email,
      authMethod: 'oauth',
      authProvider: 'google',
      authProviderId: userProfile.providerId
    })
    isNewUser = true
  }

  // Register a temporary device for the auth result
  const tempDeviceId = crypto.randomUUID()

  // Create auth result
  const result = await createAuthResult(user, tempDeviceId, c.env.JWT_SECRET, isNewUser)

  return c.json(result)
})

// -----------------------------------------------------------------------------
// Device Registration (T050) - Authenticated
// -----------------------------------------------------------------------------

auth.post(
  '/device/register',
  authMiddleware,
  zValidator('json', deviceRegistrationSchema),
  async (c) => {
    const input = c.req.valid('json')
    const authUser = c.get('user')

    // Register device
    const device = await registerDevice(c.env.DB, {
      userId: authUser.userId,
      name: input.name,
      platform: input.platform,
      osVersion: input.os_version,
      appVersion: input.app_version,
      authPublicKey: input.auth_public_key
    })

    // Generate new tokens with the REAL device ID
    // This fixes the issue where the initial login token contains a temp device ID
    // that isn't in the devices table, causing FK constraint failures in linking
    const tokens = await generateTokens(
      { id: authUser.userId, email: authUser.email } as User,
      device.id,
      c.env.JWT_SECRET
    )

    return c.json({
      ...toPublicDevice(device),
      tokens: {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: tokens.expiresIn
      }
    }, 201)
  }
)

// -----------------------------------------------------------------------------
// First Device Setup (T051) - Authenticated
// -----------------------------------------------------------------------------

auth.post('/device/setup', authMiddleware, zValidator('json', deviceSetupSchema), async (c) => {
  const { kdf_salt, key_verifier } = c.req.valid('json')
  const authUser = c.get('user')

  // Set KDF salt and key verifier
  await setKdfSaltAndVerifier(c.env.DB, authUser.userId, kdf_salt, key_verifier)

  return c.json({ message: 'Device setup complete' })
})

// -----------------------------------------------------------------------------
// Recovery Data
// -----------------------------------------------------------------------------

auth.get('/recovery', async (c) => {
  const userId = c.req.query('user_id')

  if (!userId) {
    throw new ValidationError('user_id is required')
  }

  // Get user from database (try ID, then email)
  const user = (await getUserById(c.env.DB, userId)) ?? (await getUserByEmail(c.env.DB, userId))
  if (!user) {
    throw new NotFoundError('User')
  }

  return c.json({
    kdf_salt: user.kdf_salt,
    key_verifier: user.key_verifier
  })
})

// =============================================================================
// Device Linking Endpoints (T104-T107)
// =============================================================================

// -----------------------------------------------------------------------------
// T104: Linking Session Initiation
// POST /auth/linking/initiate
// -----------------------------------------------------------------------------

auth.post(
  '/linking/initiate',
  authMiddleware,
  rateLimit(RATE_LIMITS.DEVICE_LINKING),
  zValidator('json', linkingInitiateSchema),
  async (c) => {
    const { ephemeral_public_key } = c.req.valid('json')
    const authUser = c.get('user')

    // Verify device exists before attempting linking
    // This prevents FK constraint failures when using temp device IDs from initial login
    const deviceExists = await c.env.DB.prepare(
      'SELECT 1 FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
    )
      .bind(authUser.deviceId, authUser.userId)
      .first()

    if (!deviceExists) {
      throw new ValidationError('Device not registered. Please complete device setup first.')
    }

    // Generate session ID and one-time token
    const sessionId = crypto.randomUUID()
    const token = generateLinkingToken()
    const now = Date.now()
    const expiresAt = now + 5 * 60 * 1000 // 5 minutes

    // Calculate token hash for D1 polling validation (bypasses DO status checks)
    const tokenHashBuffer = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(token)
    )
    const tokenHash = Array.from(new Uint8Array(tokenHashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    // Store in D1 linking_sessions table
    await c.env.DB.prepare(
      `INSERT INTO linking_sessions (
        id, user_id, initiator_device_id, ephemeral_public_key, token_hash,
        status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
      .bind(
        sessionId,
        authUser.userId,
        authUser.deviceId,
        ephemeral_public_key,
        tokenHash,
        now,
        expiresAt
      )
      .run()

    // Initialize Durable Object for real-time WebSocket updates
    const doId = c.env.LINKING_SESSION.idFromName(sessionId)
    const linkingDO = c.env.LINKING_SESSION.get(doId)

    await linkingDO.fetch(
      new Request('https://internal/init', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          userId: authUser.userId,
          token,
          expiresAt
        })
      })
    )

    // Build QR data for client to encode
    const qrData = JSON.stringify({
      session_id: sessionId,
      token,
      ephemeral_public_key,
      expires_at: new Date(expiresAt).toISOString()
    })

    return c.json(
      {
        session_id: sessionId,
        token,
        ephemeral_public_key,
        expires_at: new Date(expiresAt).toISOString(),
        qr_data: qrData
      },
      201
    )
  }
)

// -----------------------------------------------------------------------------
// T105: QR Scan Endpoint
// POST /auth/linking/:session_id/scan
// -----------------------------------------------------------------------------

auth.post(
  '/linking/:session_id/scan',
  rateLimit({
    ...RATE_LIMITS.DEVICE_LINKING,
    keyGenerator: (c) => {
      const ip =
        c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
      return `linking_scan:${ip}`
    }
  }),
  zValidator('json', linkingScanSchema),
  async (c) => {
    const sessionId = c.req.param('session_id')
    const { new_device_public_key, token, new_device_confirm, device_name, device_platform } =
      c.req.valid('json')

    // Find session in D1
    const session = await c.env.DB.prepare(
      `SELECT id, user_id, status, expires_at, ephemeral_public_key
       FROM linking_sessions WHERE id = ?`
    )
      .bind(sessionId)
      .first<{
        id: string
        user_id: string
        status: string
        expires_at: number
        ephemeral_public_key: string
      }>()

    if (!session) {
      throw new NotFoundError('Linking session')
    }

    // Validate session state
    if (session.expires_at < Date.now()) {
      throw new LinkingSessionError('Session has expired', 'SESSION_EXPIRED')
    }

    if (session.status !== 'pending') {
      throw new LinkingSessionError('Session already used', 'SESSION_ALREADY_USED')
    }

    // Validate token via Durable Object (constant-time comparison)
    const doId = c.env.LINKING_SESSION.idFromName(sessionId)
    const linkingDO = c.env.LINKING_SESSION.get(doId)

    const tokenValidation = await linkingDO.fetch(
      new Request('https://internal/validate-token', {
        method: 'POST',
        body: JSON.stringify({ token })
      })
    )

    if (!tokenValidation.ok) {
      const error = (await tokenValidation.json()) as { error?: string }
      if (tokenValidation.status === 410) {
        throw new LinkingSessionError('Session has expired', 'SESSION_EXPIRED')
      }
      throw new ValidationError(error.error || 'Invalid token')
    }

    // Update session with new device info
    await c.env.DB.prepare(
      `UPDATE linking_sessions
       SET new_device_public_key = ?, new_device_confirm = ?, device_name = ?, device_platform = ?, status = 'scanned'
       WHERE id = ?`
    )
      .bind(
        new_device_public_key,
        new_device_confirm,
        device_name || null,
        device_platform || null,
        sessionId
      )
      .run()

    // Notify existing device via Durable Object WebSocket (reuse existing DO reference)
    await linkingDO.fetch(
      new Request('https://internal/notify-scanned', {
        method: 'POST',
        body: JSON.stringify({
          newDevicePublicKey: new_device_public_key
        })
      })
    )

    return c.json({ status: 'scanned' })
  }
)

// -----------------------------------------------------------------------------
// T106: Linking Approval Endpoint
// POST /auth/linking/:session_id/approve
// -----------------------------------------------------------------------------

auth.post(
  '/linking/:session_id/approve',
  authMiddleware,
  rateLimit(RATE_LIMITS.DEVICE_LINKING),
  zValidator('json', linkingApproveSchema),
  async (c) => {
    const sessionId = c.req.param('session_id')
    const { encrypted_master_key, nonce, key_confirm } = c.req.valid('json')
    const authUser = c.get('user')

    // Find session in D1
    const session = await c.env.DB.prepare(
      `SELECT id, user_id, initiator_device_id, status, expires_at
       FROM linking_sessions WHERE id = ?`
    )
      .bind(sessionId)
      .first<{
        id: string
        user_id: string
        initiator_device_id: string
        status: string
        expires_at: number
      }>()

    if (!session) {
      throw new NotFoundError('Linking session')
    }

    // Verify ownership
    if (session.user_id !== authUser.userId) {
      throw new AuthenticationError('Not authorized to approve this session')
    }

    // Validate session state
    if (session.expires_at < Date.now()) {
      throw new LinkingSessionError('Session has expired', 'SESSION_EXPIRED')
    }

    if (session.status !== 'scanned') {
      throw new LinkingSessionError(
        'Session must be in scanned state to approve',
        'SESSION_INVALID'
      )
    }

    // Check device limit before allowing approval
    const deviceCount = await countActiveDevices(c.env.DB, authUser.userId)
    if (deviceCount >= 10) {
      throw new LinkingSessionError('Device limit reached (maximum 10 devices)', 'DEVICE_LIMIT_REACHED')
    }

    // Store encrypted master key
    await c.env.DB.prepare(
      `UPDATE linking_sessions
       SET encrypted_master_key = ?, encrypted_key_nonce = ?, key_confirm = ?, status = 'approved'
       WHERE id = ?`
    )
      .bind(encrypted_master_key, nonce, key_confirm, sessionId)
      .run()

    // Notify new device via Durable Object WebSocket
    const doId = c.env.LINKING_SESSION.idFromName(sessionId)
    const linkingDO = c.env.LINKING_SESSION.get(doId)

    await linkingDO.fetch(new Request('https://internal/notify-approved', { method: 'POST' }))

    return c.json({ status: 'approved' })
  }
)

// -----------------------------------------------------------------------------
// T107: Linking Completion Endpoint
// POST /auth/linking/:session_id/complete
// -----------------------------------------------------------------------------

auth.post(
  '/linking/:session_id/complete',
  rateLimit({
    ...RATE_LIMITS.DEVICE_LINKING,
    keyGenerator: (c) => {
      const ip =
        c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
      return `linking_complete:${ip}`
    }
  }),
  zValidator('json', linkingCompleteSchema),
  async (c) => {
    const sessionId = c.req.param('session_id')
    const { new_device_public_key } = c.req.valid('json')

    // Find session in D1 (including device info stored during scan)
    const session = await c.env.DB.prepare(
      `SELECT id, user_id, status, expires_at,
              encrypted_master_key, encrypted_key_nonce, key_confirm,
              new_device_public_key, device_name, device_platform
       FROM linking_sessions WHERE id = ?`
    )
      .bind(sessionId)
      .first<{
        id: string
        user_id: string
        status: string
        expires_at: number
        encrypted_master_key: string | null
        encrypted_key_nonce: string | null
        key_confirm: string | null
        new_device_public_key: string | null
        device_name: string | null
        device_platform: string | null
      }>()

    if (!session) {
      throw new NotFoundError('Linking session')
    }

    // Validate session state
    if (session.expires_at < Date.now()) {
      throw new LinkingSessionError('Session has expired', 'SESSION_EXPIRED')
    }

    if (session.status !== 'approved') {
      throw new LinkingSessionError(
        'Session not yet approved. Please wait for approval from existing device.',
        'SESSION_INVALID'
      )
    }

    if (!session.encrypted_master_key || !session.encrypted_key_nonce) {
      throw new LinkingSessionError('Encrypted key data not available', 'SESSION_INVALID')
    }

    // Verify the public key matches what was submitted during scan
    if (session.new_device_public_key !== new_device_public_key) {
      throw new ValidationError('Public key does not match the scanning device')
    }

    // Get user for token generation
    const user = await getUserById(c.env.DB, session.user_id)
    if (!user) {
      throw new NotFoundError('User')
    }

    // Register new device using info stored during scan
    const newDevice = await registerDevice(c.env.DB, {
      userId: session.user_id,
      name: session.device_name || 'Unknown Device',
      platform: (session.device_platform as 'macos' | 'windows' | 'linux' | 'ios' | 'android') || 'linux',
      osVersion: undefined,
      appVersion: '1.0.0' // Default version, could be passed during scan if needed
    })

    // Generate tokens for new device
    const tokens = await generateTokens(user, newDevice.id, c.env.JWT_SECRET)

    // Mark session as completed
    const now = Date.now()
    await c.env.DB.prepare(
      `UPDATE linking_sessions SET status = 'completed', completed_at = ? WHERE id = ?`
    )
      .bind(now, sessionId)
      .run()

    return c.json({
      encrypted_master_key: session.encrypted_master_key,
      nonce: session.encrypted_key_nonce,
      key_confirm: session.key_confirm,
      device: toPublicDevice(newDevice),
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn
      }
    })
  }
)

// -----------------------------------------------------------------------------
// T108: Linking Status Endpoint (Polling)
// GET /auth/linking/:session_id/status
//
// Token-gated: requires either:
// - Authorization header with access token (existing device)
// - ?token= query param with QR token (new device)
// -----------------------------------------------------------------------------

auth.get(
  '/linking/:session_id/status',
  rateLimit({
    ...RATE_LIMITS.LINKING_STATUS,
    keyGenerator: (c) => {
      const sessionId = c.req.param('session_id') || 'unknown'
      return `linking_status:${sessionId}`
    }
  }),
  async (c) => {
    const sessionId = c.req.param('session_id')
    const tokenParam = c.req.query('token')
    const authHeader = c.req.header('Authorization')

    // Find session in D1 (include token_hash for validation)
    const session = await c.env.DB.prepare(
      `SELECT id, user_id, status, expires_at, token_hash,
              new_device_public_key, new_device_confirm,
              device_name, device_platform
       FROM linking_sessions WHERE id = ?`
    )
      .bind(sessionId)
      .first<{
        id: string
        user_id: string
        status: string
        expires_at: number
        token_hash: string
        new_device_public_key: string | null
        new_device_confirm: string | null
        device_name: string | null
        device_platform: string | null
      }>()

    if (!session) {
      throw new NotFoundError('Linking session')
    }

    // Determine caller role based on auth method
    let callerRole: 'existing' | 'new' | null = null

    if (authHeader?.startsWith('Bearer ')) {
      // Existing device: validate access token and session ownership
      const accessToken = authHeader.slice(7)
      try {
        const payload = await verifyToken(accessToken, c.env.JWT_SECRET)
        // Must be access token (not refresh) and match session owner
        if (payload.type === 'access' && payload.sub === session.user_id) {
          callerRole = 'existing'
        }
      } catch {
        // Invalid token - fall through to check QR token
      }
    }

    if (!callerRole && tokenParam) {
      // New device: validate QR token via D1 hash comparison
      // This bypasses DO status checks, allowing polling after scan/approved states
      const providedHashBuffer = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(tokenParam)
      )
      const providedHash = Array.from(new Uint8Array(providedHashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

      if (session.token_hash === providedHash) {
        callerRole = 'new'
      }
    }

    if (!callerRole) {
      throw new AuthenticationError('Valid access token or QR token required')
    }

    // Check if expired
    const now = Date.now()
    if (session.expires_at < now && session.status !== 'completed') {
      return c.json({
        status: 'expired',
        expires_at: new Date(session.expires_at).toISOString(),
        server_timestamp: now
      })
    }

    // Build response
    const response: {
      status: string
      new_device_public_key?: string
      new_device_confirm?: string
      device_name?: string
      device_platform?: string
      expires_at: string
      server_timestamp: number
    } = {
      status: session.status,
      expires_at: new Date(session.expires_at).toISOString(),
      server_timestamp: now
    }

    // Include proof data for 'scanned' status ONLY for existing device (they need it to approve)
    if (session.status === 'scanned' && callerRole === 'existing') {
      if (session.new_device_public_key) {
        response.new_device_public_key = session.new_device_public_key
      }
      if (session.new_device_confirm) {
        response.new_device_confirm = session.new_device_confirm
      }
      if (session.device_name) {
        response.device_name = session.device_name
      }
      if (session.device_platform) {
        response.device_platform = session.device_platform
      }
    }

    return c.json(response)
  }
)

// -----------------------------------------------------------------------------
// T109: Linking Rejection Endpoint
// POST /auth/linking/:session_id/reject
// -----------------------------------------------------------------------------

auth.post(
  '/linking/:session_id/reject',
  authMiddleware,
  rateLimit(RATE_LIMITS.DEVICE_LINKING),
  async (c) => {
    const sessionId = c.req.param('session_id')
    const authUser = c.get('user')

    // Find session in D1
    const session = await c.env.DB.prepare(
      `SELECT id, user_id, status FROM linking_sessions WHERE id = ?`
    )
      .bind(sessionId)
      .first<{
        id: string
        user_id: string
        status: string
      }>()

    if (!session) {
      throw new NotFoundError('Linking session')
    }

    // Verify ownership - only the initiating user can reject
    if (session.user_id !== authUser.userId) {
      throw new AuthenticationError('Not authorized to reject this session')
    }

    // Can only reject pending or scanned sessions
    if (!['pending', 'scanned'].includes(session.status)) {
      throw new LinkingSessionError(
        'Cannot reject session in current state',
        'SESSION_INVALID'
      )
    }

    // Update status to rejected
    await c.env.DB.prepare(`UPDATE linking_sessions SET status = 'rejected' WHERE id = ?`)
      .bind(sessionId)
      .run()

    return c.json({ status: 'rejected' })
  }
)

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Generate a secure one-time token for QR code linking.
 * Uses 32 bytes of randomness encoded as URL-safe Base64.
 */
function generateLinkingToken(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  // URL-safe Base64 encoding
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// =============================================================================
// OAuth Helper Functions
// =============================================================================

function buildGoogleAuthUrl(redirectUri: string, state: string, codeChallenge: string, env: Env): string {
  const params = new URLSearchParams({
    client_id: env.OAUTH_GOOGLE_CLIENT_ID || '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  })

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

async function exchangeGoogleCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  env: Env
): Promise<{ email: string; providerId: string }> {
  // Exchange code for tokens
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.OAUTH_GOOGLE_CLIENT_ID || '',
      client_secret: env.OAUTH_GOOGLE_CLIENT_SECRET || '',
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    }).toString()
  })

  if (!tokenResponse.ok) {
    throw new AuthenticationError('Failed to exchange Google authorization code')
  }

  const tokens = (await tokenResponse.json()) as { access_token: string }

  // Get user info
  const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  })

  if (!userResponse.ok) {
    throw new AuthenticationError('Failed to get Google user info')
  }

  const userInfo = (await userResponse.json()) as { email: string; id: string }

  return {
    email: userInfo.email,
    providerId: userInfo.id
  }
}

export default auth
