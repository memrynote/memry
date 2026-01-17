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
import { authMiddleware, type AuthContext } from '../middleware/auth'
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
import { ValidationError, AuthenticationError, ConflictError, NotFoundError } from '../lib/errors'

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
  if (!['google', 'apple', 'github'].includes(provider)) {
    throw new ValidationError(`Invalid OAuth provider: ${provider}`)
  }

  // Validate required params
  if (!redirectUri || !state || !codeChallenge || !codeChallengeMethod) {
    throw new ValidationError('Missing required OAuth parameters')
  }

  // Build authorization URL based on provider
  let authUrl: string

  switch (provider) {
    case 'google':
      authUrl = buildGoogleAuthUrl(redirectUri, state, codeChallenge, c.env)
      break
    case 'apple':
      authUrl = buildAppleAuthUrl(redirectUri, state, codeChallenge, c.env)
      break
    case 'github':
      authUrl = buildGitHubAuthUrl(redirectUri, state, c.env)
      break
    default:
      throw new ValidationError(`Unsupported provider: ${provider}`)
  }

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
  if (!['google', 'apple', 'github'].includes(provider)) {
    throw new ValidationError(`Invalid OAuth provider: ${provider}`)
  }

  // Exchange code for tokens and get user profile
  let userProfile: { email: string; providerId: string }

  switch (provider) {
    case 'google':
      userProfile = await exchangeGoogleCode(code, code_verifier, redirect_uri, c.env)
      break
    case 'apple':
      userProfile = await exchangeAppleCode(code, code_verifier, c.env)
      break
    case 'github':
      userProfile = await exchangeGitHubCode(code, c.env)
      break
    default:
      throw new ValidationError(`Unsupported provider: ${provider}`)
  }

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
      authProvider: provider as 'google' | 'apple' | 'github',
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

    return c.json(toPublicDevice(device), 201)
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

function buildAppleAuthUrl(redirectUri: string, state: string, codeChallenge: string, env: Env): string {
  const params = new URLSearchParams({
    client_id: env.OAUTH_APPLE_CLIENT_ID || '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'email name',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    response_mode: 'form_post'
  })

  return `https://appleid.apple.com/auth/authorize?${params.toString()}`
}

function buildGitHubAuthUrl(redirectUri: string, state: string, env: Env): string {
  const params = new URLSearchParams({
    client_id: env.OAUTH_GITHUB_CLIENT_ID || '',
    redirect_uri: redirectUri,
    scope: 'read:user user:email',
    state
  })

  return `https://github.com/login/oauth/authorize?${params.toString()}`
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

async function exchangeAppleCode(
  code: string,
  codeVerifier: string,
  env: Env
): Promise<{ email: string; providerId: string }> {
  // Exchange code for tokens
  const tokenResponse = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.OAUTH_APPLE_CLIENT_ID || '',
      client_secret: env.OAUTH_APPLE_CLIENT_SECRET || '',
      code_verifier: codeVerifier,
      grant_type: 'authorization_code'
    }).toString()
  })

  if (!tokenResponse.ok) {
    throw new AuthenticationError('Failed to exchange Apple authorization code')
  }

  const tokens = (await tokenResponse.json()) as { id_token: string }

  // Decode ID token to get user info (Apple returns info in the ID token)
  const payload = JSON.parse(atob(tokens.id_token.split('.')[1])) as {
    sub: string
    email?: string
  }

  if (!payload.email) {
    throw new AuthenticationError('Apple did not return email address')
  }

  return {
    email: payload.email,
    providerId: payload.sub
  }
}

async function exchangeGitHubCode(
  code: string,
  env: Env
): Promise<{ email: string; providerId: string }> {
  // Exchange code for tokens
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      client_id: env.OAUTH_GITHUB_CLIENT_ID || '',
      client_secret: env.OAUTH_GITHUB_CLIENT_SECRET || '',
      code
    })
  })

  if (!tokenResponse.ok) {
    throw new AuthenticationError('Failed to exchange GitHub authorization code')
  }

  const tokens = (await tokenResponse.json()) as { access_token: string }

  // Get user info
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json'
    }
  })

  if (!userResponse.ok) {
    throw new AuthenticationError('Failed to get GitHub user info')
  }

  const userInfo = (await userResponse.json()) as { id: number; email: string | null }

  // Get email if not public
  let email = userInfo.email
  if (!email) {
    const emailsResponse = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/json'
      }
    })

    if (emailsResponse.ok) {
      const emails = (await emailsResponse.json()) as Array<{
        email: string
        primary: boolean
        verified: boolean
      }>
      const primaryEmail = emails.find((e) => e.primary && e.verified)
      email = primaryEmail?.email || null
    }
  }

  if (!email) {
    throw new AuthenticationError('GitHub account must have a verified email address')
  }

  return {
    email,
    providerId: userInfo.id.toString()
  }
}

export default auth
