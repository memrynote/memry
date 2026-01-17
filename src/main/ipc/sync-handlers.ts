/**
 * Sync IPC Handlers
 *
 * Handles IPC communication for sync operations between the main process
 * and renderer. Provides entry points for authentication, sync status,
 * device management, and device linking operations.
 *
 * @module main/ipc/sync-handlers
 */

import { ipcMain, shell } from 'electron'
import { randomBytes } from 'crypto'
import {
  SYNC_CHANNELS,
  SYNC_EVENTS,
  TriggerSyncInputSchema,
  GetHistoryInputSchema,
  RemoveDeviceInputSchema,
  RenameDeviceInputSchema,
  LinkViaQRInputSchema,
  ApproveLinkingInputSchema,
  CompleteLinkingInputSchema,
  LinkViaRecoveryInputSchema,
  EmailSignupInputSchema,
  EmailLoginInputSchema,
  EmailVerifyInputSchema,
  ForgotPasswordInputSchema,
  ResetPasswordInputSchema,
  ChangePasswordInputSchema,
  OAuthStartInputSchema,
  OAuthCallbackInputSchema,
  type SetupStatus,
  type EmailSignupInput,
  type EmailLoginInput,
  type EmailVerifyInput,
  type ForgotPasswordInput,
  type ResetPasswordInput,
  type ChangePasswordInput,
  type OAuthStartInput,
  type OAuthCallbackInput
} from '@shared/contracts/ipc-sync'
import type { SyncStatus } from '@shared/contracts/sync-api'
import { createValidatedHandler, createHandler } from './validate'
import { syncApi, SyncApiError } from '../sync/api-client'
import { startOAuthServer, getOAuthCallbackUrl, isLoopbackOAuth } from '../sync/oauth-server'
import { generateRecoveryPhrase, validateRecoveryPhrase, mnemonicToSeed } from '../crypto/recovery'
import {
  deriveMasterKey,
  generateKdfSalt,
  computeKeyVerifier,
  verifyKeyVerifier,
  generateX25519KeyPair,
  computeX25519SharedSecret,
  deriveLinkingKeys,
  computeNewDeviceConfirm,
  verifyNewDeviceConfirm,
  computeKeyConfirm,
  verifyKeyConfirm
} from '../crypto/keys'
import {
  encryptMasterKeyForLinking,
  decryptMasterKeyForLinking
} from '../crypto/encryption'
import {
  saveSyncSession,
  getSyncSession,
  clearSyncSession,
  getTokens,
  saveTokens,
  hasMasterKey,
  getUserId,
  getDeviceId,
  savePendingSignup,
  getPendingSignup,
  deletePendingSignup
} from '../crypto/keychain'
import { app } from 'electron'
import os from 'os'

// =============================================================================
// Types
// =============================================================================

/** Password validation result */
export interface PasswordValidation {
  valid: boolean
  errors: string[]
  strength: 'weak' | 'fair' | 'strong' | 'very-strong'
}

/** Stored state during signup flow */
interface SignupState {
  email: string
  password: string
  deviceName: string
  recoveryPhrase: string
  userId?: string
}

/** Stored state during OAuth flow */
interface OAuthState {
  provider: 'google'
  deviceName: string
  state: string
  codeVerifier: string
  redirectUri: string
  closeServer?: () => void
}

/** Active linking session state (existing device) */
interface ActiveLinkingSession {
  sessionId: string
  token: string
  ephemeralKeyPair: { publicKey: Buffer; secretKey: Buffer }
  expiresAt: number
  status: 'pending' | 'scanned' | 'approved' | 'rejected'
  newDevicePublicKey?: Buffer
  newDeviceConfirm?: Buffer
  deviceName?: string
  devicePlatform?: 'macos' | 'windows' | 'linux' | 'ios' | 'android'
  linkingKeys?: { encKey: Buffer; macKey: Buffer }
}

/** Pending linking request state (new device) */
interface PendingLinkingRequest {
  sessionId: string
  token: string
  existingDevicePublicKey: Buffer
  myKeyPair: { publicKey: Buffer; secretKey: Buffer }
  linkingKeys: { encKey: Buffer; macKey: Buffer }
  deviceName: string
  devicePlatform: 'macos' | 'windows' | 'linux' | 'ios' | 'android'
  expiresAt: number
}

// =============================================================================
// State (in-memory during signup flow)
// =============================================================================

/** Temporary state during signup flow (cleared after completion or timeout) */
let pendingSignup: SignupState | null = null
let signupTimeout: NodeJS.Timeout | null = null

/** Temporary state during OAuth flow */
let pendingOAuth: OAuthState | null = null

/** Active linking session (existing device initiating link) */
let activeLinkingSession: ActiveLinkingSession | null = null

/** Pending linking request (new device waiting for approval) */
let pendingLinkingRequest: PendingLinkingRequest | null = null

// =============================================================================
// Password Validation
// =============================================================================

/**
 * Validate password strength.
 *
 * Requirements:
 * - Minimum 12 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - At least one special character
 *
 * @param password - Password to validate
 * @returns Validation result with strength assessment
 */
export function validatePassword(password: string): PasswordValidation {
  const errors: string[] = []

  if (password.length < 12) {
    errors.push('Must be at least 12 characters')
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Must contain an uppercase letter')
  }

  if (!/[a-z]/.test(password)) {
    errors.push('Must contain a lowercase letter')
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Must contain a number')
  }

  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password)) {
    errors.push('Must contain a special character')
  }

  // Calculate strength
  let strength: PasswordValidation['strength'] = 'weak'
  const passedChecks = 5 - errors.length

  if (errors.length === 0) {
    if (password.length >= 20) {
      strength = 'very-strong'
    } else if (password.length >= 16) {
      strength = 'strong'
    } else {
      strength = 'fair'
    }
  } else if (passedChecks >= 3) {
    strength = 'fair'
  }

  return {
    valid: errors.length === 0,
    errors,
    strength
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get device platform from os module
 */
function getDevicePlatform(): 'macos' | 'windows' | 'linux' {
  const platform = os.platform()
  switch (platform) {
    case 'darwin':
      return 'macos'
    case 'win32':
      return 'windows'
    default:
      return 'linux'
  }
}

/**
 * Clear pending signup state
 */
async function clearPendingSignup(): Promise<void> {
  pendingSignup = null
  if (signupTimeout) {
    clearTimeout(signupTimeout)
    signupTimeout = null
  }
  // Also clear from keychain
  await deletePendingSignup()
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  // Generate random 32 bytes for code verifier
  const verifierBytes = randomBytes(32)
  const codeVerifier = verifierBytes.toString('base64url')

  // SHA256 hash the verifier and base64url encode for challenge
  const crypto = require('crypto')
  const hash = crypto.createHash('sha256').update(codeVerifier).digest()
  const codeChallenge = hash.toString('base64url')

  return { codeVerifier, codeChallenge }
}

// =============================================================================
// Status Functions
// =============================================================================

/**
 * Get current setup status
 */
const getSetupStatus = async (): Promise<SetupStatus> => {
  const [userId, deviceId, masterKeyExists, tokens] = await Promise.all([
    getUserId(),
    getDeviceId(),
    hasMasterKey(),
    getTokens()
  ])

  return {
    isSetup: !!(userId && deviceId && masterKeyExists && tokens),
    hasUser: !!userId,
    hasDevice: !!deviceId,
    hasMasterKey: masterKeyExists,
    hasTokens: !!tokens
  }
}

/**
 * Get current sync status
 */
const getSyncStatus = async (): Promise<SyncStatus> => {
  // TODO: Implement full sync status in Phase 3+
  const session = await getSyncSession()

  return {
    state: session ? 'idle' : 'offline',
    pendingCount: 0,
    retryCount: 0,
    isOnline: !!session
  }
}

// =============================================================================
// Handler Registration
// =============================================================================

/**
 * Register all sync-related IPC handlers.
 */
export function registerSyncHandlers(): void {
  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  ipcMain.handle(SYNC_CHANNELS.GET_SETUP_STATUS, createHandler(getSetupStatus))

  /**
   * T062 - First Device Setup (Complete signup after recovery phrase confirmation)
   *
   * Called after user has confirmed their recovery phrase words.
   * Derives master key, stores in keychain, and registers device with server.
   */
  ipcMain.handle(
    SYNC_CHANNELS.SETUP_FIRST_DEVICE,
    createHandler(async () => {
      // If not in memory, try to load from keychain (survives app restart)
      if (!pendingSignup) {
        const keychainData = await getPendingSignup()
        if (keychainData) {
          pendingSignup = {
            email: keychainData.email,
            password: keychainData.password,
            deviceName: keychainData.deviceName,
            recoveryPhrase: keychainData.recoveryPhrase,
            userId: keychainData.userId
          }
        }
      }

      // Verify we have a pending signup
      if (!pendingSignup) {
        throw new Error('No pending signup. Please start the signup process again.')
      }

      const { recoveryPhrase, deviceName } = pendingSignup

      try {
        // Get tokens from keychain (set during email verification)
        const tokens = await getTokens()
        if (!tokens) {
          throw new Error('No authentication tokens found. Please verify your email first.')
        }

        // Generate KDF salt
        const kdfSalt = generateKdfSalt()
        const kdfSaltBase64 = kdfSalt.toString('base64')

        // Derive seed from recovery phrase
        const seed = await mnemonicToSeed(recoveryPhrase)

        // Derive master key
        const masterKey = deriveMasterKey(seed, kdfSalt)

        // Compute key verifier
        const keyVerifier = computeKeyVerifier(masterKey)
        const keyVerifierBase64 = keyVerifier.toString('base64')

        // Send KDF salt and key verifier to server
        await syncApi.instance.setupDevice(kdfSaltBase64, keyVerifierBase64, tokens.accessToken)

        // Register device with server
        const device = await syncApi.instance.registerDevice(
          deviceName,
          getDevicePlatform(),
          app.getVersion(),
          tokens.accessToken,
          os.release()
        )

        // Save complete session to keychain
        // Use NEW tokens from device registration (contain real device ID, not temp ID)
        const userId = await getUserId()
        if (!userId) {
          throw new Error('User ID not found in keychain')
        }

        await saveSyncSession({
          userId,
          deviceId: device.id,
          accessToken: device.tokens.access_token,
          refreshToken: device.tokens.refresh_token,
          masterKey
        })

        // Clear pending signup state
        clearPendingSignup()

        return {
          success: true,
          deviceId: device.id,
          userId
        }
      } catch (error) {
        // Don't clear signup state on error so user can retry
        if (error instanceof SyncApiError) {
          throw new Error(error.message)
        }
        throw error
      }
    })
  )

  // ---------------------------------------------------------------------------
  // Auth (Email)
  // ---------------------------------------------------------------------------

  /**
   * T054 - Email Signup
   *
   * Creates user account and generates recovery phrase.
   * Recovery phrase is returned to UI for user to write down.
   * User must verify email and confirm recovery phrase before keys are derived.
   */
  ipcMain.handle(
    SYNC_CHANNELS.EMAIL_SIGNUP,
    createValidatedHandler(EmailSignupInputSchema, async (input: EmailSignupInput) => {
      const { email, password, deviceName } = input

      // Validate password strength
      const passwordCheck = validatePassword(password)
      if (!passwordCheck.valid) {
        throw new Error(`Password too weak: ${passwordCheck.errors.join(', ')}`)
      }

      // Generate recovery phrase
      const recoveryPhrase = generateRecoveryPhrase()

      try {
        // Create account on server (sends verification email)
        const result = await syncApi.instance.emailSignup(email, password)

        // Store pending signup state in memory AND keychain (survives app restart)
        pendingSignup = {
          email,
          password,
          deviceName,
          recoveryPhrase,
          userId: result.user_id
        }

        // Persist to keychain so it survives app restart
        await savePendingSignup({
          email,
          password,
          deviceName,
          recoveryPhrase,
          userId: result.user_id,
          createdAt: Date.now()
        })

        // Clear any existing timeout (don't clear keychain data)
        if (signupTimeout) {
          clearTimeout(signupTimeout)
        }
        // Set timeout to clear state after 30 minutes
        signupTimeout = setTimeout(() => void clearPendingSignup(), 30 * 60 * 1000)

        return {
          success: true,
          userId: result.user_id,
          recoveryPhrase,
          message: 'Verification email sent. Please check your inbox.'
        }
      } catch (error) {
        if (error instanceof SyncApiError) {
          if (error.isConflictError()) {
            throw new Error('An account with this email already exists')
          }
          throw new Error(error.message)
        }
        throw error
      }
    })
  )

  /**
   * T055 - Email Verification
   *
   * Verifies email with token from verification link.
   * Returns auth tokens but does NOT derive keys yet.
   */
  ipcMain.handle(
    SYNC_CHANNELS.EMAIL_VERIFY,
    createValidatedHandler(EmailVerifyInputSchema, async (input: EmailVerifyInput) => {
      const { token } = input

      // If not in memory, try to load from keychain
      if (!pendingSignup) {
        const keychainData = await getPendingSignup()
        if (keychainData) {
          pendingSignup = {
            email: keychainData.email,
            password: keychainData.password,
            deviceName: keychainData.deviceName,
            recoveryPhrase: keychainData.recoveryPhrase,
            userId: keychainData.userId
          }
        }
      }

      try {
        const result = await syncApi.instance.emailVerify(token)

        // Store tokens and user ID in keychain (master key comes later in setup)
        await saveTokens(result.tokens.accessToken, result.tokens.refreshToken)
        const keychain = await import('../crypto/keychain')
        await keychain.saveUserId(result.user.id)

        // Update pending signup with userId if present
        if (pendingSignup && pendingSignup.email === result.user.email) {
          pendingSignup.userId = result.user.id
        }

        return {
          success: true,
          user: result.user,
          needsSetup: result.needsDeviceSetup,
          recoveryPhrase: pendingSignup?.recoveryPhrase ?? null
        }
      } catch (error) {
        if (error instanceof SyncApiError) {
          throw new Error(error.message)
        }
        throw error
      }
    })
  )

  /**
   * T056 - Email Login
   *
   * Login with email and password.
   * For existing users, retrieves KDF salt to derive master key.
   */
  ipcMain.handle(
    SYNC_CHANNELS.EMAIL_LOGIN,
    createValidatedHandler(EmailLoginInputSchema, async (input: EmailLoginInput) => {
      const { email, password, deviceName } = input

      try {
        // Login to server
        const result = await syncApi.instance.emailLogin(email, password)

        // Check if we have master key locally
        // Even if server says device exists, if we cleared keychain locally,
        // we need the recovery phrase to derive the master key again
        const localHasMasterKey = await hasMasterKey()

        // Need recovery phrase if:
        // 1. Server says we need device setup (new device), OR
        // 2. We don't have master key locally (keychain was cleared)
        const needsRecoveryPhrase = result.needsDeviceSetup || !localHasMasterKey

        if (needsRecoveryPhrase) {
          // Get recovery data from server
          const recoveryData = await syncApi.instance.getRecoveryData(result.user.id)

          // Save tokens and userId to keychain so LINK_VIA_RECOVERY can use them
          await saveTokens(result.tokens.accessToken, result.tokens.refreshToken)
          const keychain = await import('../crypto/keychain')
          await keychain.saveUserId(result.user.id)

          return {
            success: true,
            user: result.user,
            needsRecoveryPhrase: true,
            kdfSalt: recoveryData.kdf_salt,
            keyVerifier: recoveryData.key_verifier,
            tokens: result.tokens,
            deviceName
          }
        }

        // For returning device with existing master key
        await saveTokens(result.tokens.accessToken, result.tokens.refreshToken)
        const keychain = await import('../crypto/keychain')
        await keychain.saveUserId(result.user.id)

        return {
          success: true,
          user: result.user,
          needsRecoveryPhrase: false,
          tokens: result.tokens
        }
      } catch (error) {
        if (error instanceof SyncApiError) {
          if (error.isAuthError()) {
            throw new Error('Invalid email or password')
          }
          throw new Error(error.message)
        }
        throw error
      }
    })
  )

  /**
   * T056d - Resend Verification Email
   */
  ipcMain.handle(
    SYNC_CHANNELS.RESEND_VERIFICATION,
    createHandler(async () => {
      // If not in memory, try to load from keychain
      if (!pendingSignup) {
        const keychainData = await getPendingSignup()
        if (keychainData) {
          pendingSignup = {
            email: keychainData.email,
            password: keychainData.password,
            deviceName: keychainData.deviceName,
            recoveryPhrase: keychainData.recoveryPhrase,
            userId: keychainData.userId
          }
        }
      }

      // Get email from pending signup or throw
      if (!pendingSignup?.email) {
        throw new Error('No pending signup. Please start the signup process again.')
      }

      try {
        await syncApi.instance.resendVerification(pendingSignup.email)
        return { success: true, message: 'Verification email sent' }
      } catch (error) {
        if (error instanceof SyncApiError) {
          throw new Error(error.message)
        }
        throw error
      }
    })
  )

  /**
   * T056a - Forgot Password
   */
  ipcMain.handle(
    SYNC_CHANNELS.FORGOT_PASSWORD,
    createValidatedHandler(ForgotPasswordInputSchema, async (input: ForgotPasswordInput) => {
      try {
        await syncApi.instance.forgotPassword(input.email)
        return {
          success: true,
          message: 'If an account exists with this email, a password reset link has been sent'
        }
      } catch (error) {
        // Always return success to prevent email enumeration
        return {
          success: true,
          message: 'If an account exists with this email, a password reset link has been sent'
        }
      }
    })
  )

  /**
   * T056b - Reset Password
   */
  ipcMain.handle(
    SYNC_CHANNELS.RESET_PASSWORD,
    createValidatedHandler(ResetPasswordInputSchema, async (input: ResetPasswordInput) => {
      const { token, newPassword } = input

      // Validate new password
      const passwordCheck = validatePassword(newPassword)
      if (!passwordCheck.valid) {
        throw new Error(`Password too weak: ${passwordCheck.errors.join(', ')}`)
      }

      try {
        await syncApi.instance.resetPassword(token, newPassword)
        return { success: true, message: 'Password has been reset successfully' }
      } catch (error) {
        if (error instanceof SyncApiError) {
          throw new Error(error.message)
        }
        throw error
      }
    })
  )

  /**
   * T056c - Change Password (Authenticated)
   */
  ipcMain.handle(
    SYNC_CHANNELS.CHANGE_PASSWORD,
    createValidatedHandler(ChangePasswordInputSchema, async (input: ChangePasswordInput) => {
      const { currentPassword, newPassword } = input

      // Validate new password
      const passwordCheck = validatePassword(newPassword)
      if (!passwordCheck.valid) {
        throw new Error(`Password too weak: ${passwordCheck.errors.join(', ')}`)
      }

      // Get current tokens
      const tokens = await getTokens()
      if (!tokens) {
        throw new Error('Not logged in')
      }

      try {
        await syncApi.instance.changePassword(currentPassword, newPassword, tokens.accessToken)
        return { success: true, message: 'Password changed successfully' }
      } catch (error) {
        if (error instanceof SyncApiError) {
          if (error.isAuthError()) {
            throw new Error('Current password is incorrect')
          }
          throw new Error(error.message)
        }
        throw error
      }
    })
  )

  /**
   * Logout - Clear session
   */
  ipcMain.handle(
    SYNC_CHANNELS.LOGOUT,
    createHandler(async () => {
      await clearSyncSession()
      clearPendingSignup()
      pendingOAuth = null
      return { success: true }
    })
  )

  // ---------------------------------------------------------------------------
  // Auth (OAuth)
  // ---------------------------------------------------------------------------

  /**
   * T057 - OAuth Start
   *
   * Opens OAuth provider authorization URL in default browser.
   * Uses loopback server for callback when configured.
   */
  ipcMain.handle(
    SYNC_CHANNELS.OAUTH_START,
    createValidatedHandler(OAuthStartInputSchema, async (input: OAuthStartInput) => {
      const { provider, deviceName } = input

      // Generate PKCE challenge
      const { codeVerifier, codeChallenge } = generatePKCE()

      // Generate state for CSRF protection
      const state = randomBytes(16).toString('hex')

      let redirectUri: string
      let closeServer: (() => void) | undefined

      if (isLoopbackOAuth()) {
        // Start loopback server for callback
        const server = await startOAuthServer()
        redirectUri = getOAuthCallbackUrl(server.port)
        closeServer = server.close

        // Store OAuth state with server reference
        pendingOAuth = {
          provider,
          deviceName,
          state,
          codeVerifier,
          redirectUri,
          closeServer
        }

        // Get OAuth URL and open in browser
        const authUrl = syncApi.instance.getOAuthUrl(provider, redirectUri, state, codeChallenge)
        await shell.openExternal(authUrl)

        // Wait for callback in background and emit event
        server
          .waitForCallback()
          .then(async (callbackParams) => {
            // Process callback automatically
            try {
              await processOAuthCallback(callbackParams.code, callbackParams.state)
            } catch (error) {
              console.error('[OAuth] Failed to process callback:', error)
              // Emit error event to renderer
              const { BrowserWindow } = await import('electron')
              const mainWindow = BrowserWindow.getAllWindows()[0]
              if (mainWindow) {
                mainWindow.webContents.send(SYNC_EVENTS.AUTH_ERROR, {
                  error: error instanceof Error ? error.message : 'OAuth failed'
                })
              }
            }
          })
          .catch((error) => {
            console.error('[OAuth] Callback error:', error)
            pendingOAuth?.closeServer?.()
            pendingOAuth = null
          })
      } else {
        // Use production callback URL
        redirectUri = getOAuthCallbackUrl()

        // Store OAuth state
        pendingOAuth = {
          provider,
          deviceName,
          state,
          codeVerifier,
          redirectUri
        }

        // Get OAuth URL and open in browser
        const authUrl = syncApi.instance.getOAuthUrl(provider, redirectUri, state, codeChallenge)
        await shell.openExternal(authUrl)
      }

      return {
        success: true,
        state,
        message: 'Opening authorization page in browser'
      }
    })
  )

  /**
   * Process OAuth callback internally (used by loopback server)
   */
  async function processOAuthCallback(code: string, state: string) {
    // Verify state matches
    if (!pendingOAuth || pendingOAuth.state !== state) {
      throw new Error('Invalid OAuth state. Please try again.')
    }

    const { provider, deviceName, codeVerifier, redirectUri, closeServer } = pendingOAuth

    try {
      // Exchange code for tokens
      const result = await syncApi.instance.oauthCallback(
        provider,
        code,
        state,
        codeVerifier,
        redirectUri
      )

      // Store tokens
      await saveTokens(result.tokens.accessToken, result.tokens.refreshToken)
      const keychain = await import('../crypto/keychain')
      await keychain.saveUserId(result.user.id)

      // Close server if running
      closeServer?.()

      // Clear OAuth state
      pendingOAuth = null

      // Import BrowserWindow to send events
      const { BrowserWindow } = await import('electron')
      const mainWindow = BrowserWindow.getAllWindows()[0]

      if (result.isNewUser) {
        // Generate recovery phrase for new OAuth users
        const recoveryPhrase = generateRecoveryPhrase()

        // Store as pending signup
        pendingSignup = {
          email: result.user.email,
          password: '', // OAuth users don't have password
          deviceName,
          recoveryPhrase,
          userId: result.user.id
        }

        // Emit success event to renderer
        if (mainWindow) {
          mainWindow.webContents.send(SYNC_EVENTS.AUTH_SUCCESS, {
            success: true,
            isNewUser: true,
            user: result.user,
            recoveryPhrase,
            needsSetup: true
          })
        }
        return
      }

      // Existing OAuth user needs to enter recovery phrase
      const recoveryData = await syncApi.instance.getRecoveryData(result.user.id)

      // Emit success event to renderer
      if (mainWindow) {
        mainWindow.webContents.send(SYNC_EVENTS.AUTH_SUCCESS, {
          success: true,
          isNewUser: false,
          user: result.user,
          needsRecoveryPhrase: true,
          kdfSalt: recoveryData.kdf_salt,
          keyVerifier: recoveryData.key_verifier,
          deviceName
        })
      }
    } catch (error) {
      closeServer?.()
      pendingOAuth = null
      throw error
    }
  }

  /**
   * T057 - OAuth Callback
   *
   * Handles OAuth callback after user authorizes.
   * For new users, generates recovery phrase.
   * Note: With loopback OAuth, this is called automatically by the loopback server.
   */
  ipcMain.handle(
    SYNC_CHANNELS.OAUTH_CALLBACK,
    createValidatedHandler(OAuthCallbackInputSchema, async (input: OAuthCallbackInput) => {
      const { code, state } = input

      // Verify state matches
      if (!pendingOAuth || pendingOAuth.state !== state) {
        throw new Error('Invalid OAuth state. Please try again.')
      }

      const { provider, deviceName, codeVerifier, redirectUri, closeServer } = pendingOAuth

      try {
        // Exchange code for tokens
        const result = await syncApi.instance.oauthCallback(
          provider,
          code,
          state,
          codeVerifier,
          redirectUri
        )

        // Store tokens
        await saveTokens(result.tokens.accessToken, result.tokens.refreshToken)
        const keychain = await import('../crypto/keychain')
        await keychain.saveUserId(result.user.id)

        // Close server if running
        closeServer?.()

        // Clear OAuth state
        pendingOAuth = null

        if (result.isNewUser) {
          // Generate recovery phrase for new OAuth users
          const recoveryPhrase = generateRecoveryPhrase()

          // Store as pending signup
          pendingSignup = {
            email: result.user.email,
            password: '', // OAuth users don't have password
            deviceName,
            recoveryPhrase,
            userId: result.user.id
          }

          return {
            success: true,
            isNewUser: true,
            user: result.user,
            recoveryPhrase,
            needsSetup: true
          }
        }

        // Existing OAuth user needs to enter recovery phrase
        const recoveryData = await syncApi.instance.getRecoveryData(result.user.id)

        return {
          success: true,
          isNewUser: false,
          user: result.user,
          needsRecoveryPhrase: true,
          kdfSalt: recoveryData.kdf_salt,
          keyVerifier: recoveryData.key_verifier,
          deviceName
        }
      } catch (error) {
        closeServer?.()
        pendingOAuth = null
        if (error instanceof SyncApiError) {
          throw new Error(error.message)
        }
        throw error
      }
    })
  )

  // ---------------------------------------------------------------------------
  // Sync Status
  // ---------------------------------------------------------------------------

  ipcMain.handle(SYNC_CHANNELS.GET_STATUS, createHandler(getSyncStatus))

  // T094: Trigger sync
  ipcMain.handle(
    SYNC_CHANNELS.TRIGGER_SYNC,
    createValidatedHandler(TriggerSyncInputSchema, async (_input) => {
      const { getSyncEngine } = await import('../sync/engine')
      const engine = getSyncEngine()

      // Ensure engine is initialized
      await engine.initialize()

      // Check if initialization succeeded
      if (!engine.isReady()) {
        return {
          success: false,
          pushed: 0,
          pulled: 0,
          conflicts: 0,
          errors: ['Sync engine not ready - missing device or user ID']
        }
      }

      try {
        const result = await engine.sync()
        return {
          success: result.errors.length === 0,
          pushed: result.pushed,
          pulled: result.pulled,
          conflicts: result.conflicts,
          errors: result.errors
        }
      } catch (error) {
        return {
          success: false,
          pushed: 0,
          pulled: 0,
          conflicts: 0,
          errors: [error instanceof Error ? error.message : String(error)]
        }
      }
    })
  )

  // T097: Pause sync
  ipcMain.handle(
    SYNC_CHANNELS.PAUSE_SYNC,
    createHandler(async () => {
      const { getSyncEngine } = await import('../sync/engine')
      const engine = getSyncEngine()
      engine.pause()
      return { success: true }
    })
  )

  // T097: Resume sync
  ipcMain.handle(
    SYNC_CHANNELS.RESUME_SYNC,
    createHandler(async () => {
      const { getSyncEngine } = await import('../sync/engine')
      const engine = getSyncEngine()
      engine.resume()
      return { success: true }
    })
  )

  // T096: Get queue size
  ipcMain.handle(
    SYNC_CHANNELS.GET_QUEUE_SIZE,
    createHandler(async () => {
      const { getSyncQueue } = await import('../sync/queue')
      const queue = getSyncQueue()
      const size = await queue.getPendingCount()
      return { size }
    })
  )

  // ---------------------------------------------------------------------------
  // Sync History
  // ---------------------------------------------------------------------------

  ipcMain.handle(
    SYNC_CHANNELS.GET_HISTORY,
    createValidatedHandler(GetHistoryInputSchema, async (input) => {
      const { getDatabase } = await import('../database/client')
      const { syncHistory } = await import('@shared/db/schema/sync')
      const { desc, count } = await import('drizzle-orm')

      const db = getDatabase()
      const limit = input.limit ?? 50
      const offset = input.offset ?? 0

      // Get total count
      const [countResult] = await db.select({ count: count() }).from(syncHistory)
      const total = countResult?.count ?? 0

      // Get entries
      const entries = await db
        .select()
        .from(syncHistory)
        .orderBy(desc(syncHistory.createdAt))
        .limit(limit)
        .offset(offset)

      return {
        entries: entries.map(e => ({
          id: e.id,
          type: e.type as 'push' | 'pull' | 'error',
          itemCount: e.itemCount,
          direction: e.direction as 'upload' | 'download' | undefined,
          details: e.details as Record<string, unknown> | undefined,
          durationMs: e.durationMs ?? undefined,
          createdAt: new Date(e.createdAt).getTime()
        })),
        total,
        hasMore: offset + entries.length < total
      }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.CLEAR_HISTORY,
    createHandler(async () => {
      const { getDatabase } = await import('../database/client')
      const { syncHistory } = await import('@shared/db/schema/sync')

      const db = getDatabase()
      await db.delete(syncHistory)
      return { success: true }
    })
  )

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------

  ipcMain.handle(
    SYNC_CHANNELS.GET_DEVICES,
    createHandler(async () => {
      // TODO: Implement in Phase 3+ (User Story 5)
      return { devices: [] }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.REMOVE_DEVICE,
    createValidatedHandler(RemoveDeviceInputSchema, async (_input) => {
      // TODO: Implement in Phase 3+ (User Story 5)
      throw new Error('Not implemented: REMOVE_DEVICE')
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.RENAME_DEVICE,
    createValidatedHandler(RenameDeviceInputSchema, async (_input) => {
      // TODO: Implement in Phase 3+
      throw new Error('Not implemented: RENAME_DEVICE')
    })
  )

  // ---------------------------------------------------------------------------
  // Device Linking (QR)
  // ---------------------------------------------------------------------------

  /**
   * T112 - Generate Linking QR
   *
   * Generates a QR code for linking a new device.
   * Existing device calls this to start the linking process.
   *
   * Flow:
   * 1. Generate X25519 ephemeral key pair
   * 2. Call POST /auth/linking/initiate with ephemeral public key
   * 3. Store session state in memory
   * 4. Return QR data for display
   */
  ipcMain.handle(
    SYNC_CHANNELS.GENERATE_LINKING_QR,
    createHandler(async () => {
      // Get tokens for authenticated request
      const tokens = await getTokens()
      if (!tokens) {
        throw new Error('Not logged in. Please sign in first.')
      }

      // Generate X25519 ephemeral key pair (T109)
      const ephemeralKeyPair = generateX25519KeyPair()
      const ephemeralPublicKeyBase64 = ephemeralKeyPair.publicKey.toString('base64')

      try {
        // Initiate linking session with server
        const response = await syncApi.instance.initiateLinking(
          ephemeralPublicKeyBase64,
          tokens.accessToken
        )

        const expiresAt = new Date(response.expires_at).getTime()

        // Store session state in memory
        activeLinkingSession = {
          sessionId: response.session_id,
          token: response.token,
          ephemeralKeyPair,
          expiresAt,
          status: 'pending'
        }

        // Set timeout to clean up expired sessions (5 minutes + buffer)
        setTimeout(() => {
          if (activeLinkingSession?.sessionId === response.session_id) {
            // Zero out secret key before clearing
            activeLinkingSession.ephemeralKeyPair.secretKey.fill(0)
            if (activeLinkingSession.linkingKeys) {
              activeLinkingSession.linkingKeys.encKey.fill(0)
              activeLinkingSession.linkingKeys.macKey.fill(0)
            }
            activeLinkingSession = null
          }
        }, 6 * 60 * 1000) // 6 minutes

        // Return QR data - stringify the payload per GenerateLinkingQROutput contract
        return {
          success: true,
          qrData: JSON.stringify({
            sessionId: response.session_id,
            token: response.token,
            ephemeralPublicKey: ephemeralPublicKeyBase64,
            expiresAt
          }),
          expiresAt
        }
      } catch (error) {
        // Zero out key material on error
        ephemeralKeyPair.secretKey.fill(0)
        if (error instanceof SyncApiError) {
          throw new Error(error.message)
        }
        throw error
      }
    })
  )

  /**
   * T113 - Link via QR (New Device)
   *
   * Called by new device after scanning the QR code.
   *
   * Flow:
   * 1. Parse QR data, validate expiry
   * 2. Generate X25519 key pair
   * 3. Compute shared secret with existing device's public key
   * 4. Derive linking keys (encKey, macKey)
   * 5. Compute new_device_confirm HMAC
   * 6. Call POST /auth/linking/{sessionId}/scan
   * 7. Store pending request, wait for approval
   */
  ipcMain.handle(
    SYNC_CHANNELS.LINK_VIA_QR,
    createValidatedHandler(LinkViaQRInputSchema, async (input) => {
      const { sessionId, token, ephemeralPublicKey, deviceName } = input

      // Parse existing device's public key
      const existingDevicePublicKey = Buffer.from(ephemeralPublicKey, 'base64')
      if (existingDevicePublicKey.length !== 32) {
        throw new Error('Invalid ephemeral public key')
      }

      // Generate our X25519 key pair (T109)
      const myKeyPair = generateX25519KeyPair()

      try {
        // Compute shared secret (T110)
        const sharedSecret = computeX25519SharedSecret(
          myKeyPair.secretKey,
          existingDevicePublicKey
        )

        // Derive linking keys (T110)
        const linkingKeys = deriveLinkingKeys(sharedSecret)

        // Zero out shared secret immediately
        sharedSecret.fill(0)

        // Compute new_device_confirm HMAC (T110a)
        const myPublicKeyBase64 = myKeyPair.publicKey.toString('base64')
        const newDeviceConfirm = computeNewDeviceConfirm(
          linkingKeys.macKey,
          sessionId,
          token,
          myPublicKeyBase64
        )

        const devicePlatform = getDevicePlatform()

        // Call server to scan QR
        await syncApi.instance.scanLinkingQR(
          sessionId,
          token,
          myPublicKeyBase64,
          newDeviceConfirm.toString('base64'),
          deviceName,
          devicePlatform
        )

        // Store pending request for when approval comes
        pendingLinkingRequest = {
          sessionId,
          token,
          existingDevicePublicKey,
          myKeyPair,
          linkingKeys,
          deviceName,
          devicePlatform,
          expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
        }

        // Set timeout to clean up
        setTimeout(() => {
          if (pendingLinkingRequest?.sessionId === sessionId) {
            // Zero out key material
            pendingLinkingRequest.myKeyPair.secretKey.fill(0)
            pendingLinkingRequest.linkingKeys.encKey.fill(0)
            pendingLinkingRequest.linkingKeys.macKey.fill(0)
            pendingLinkingRequest = null
          }
        }, 6 * 60 * 1000)

        return {
          success: true,
          message: 'Waiting for approval from existing device',
          sessionId
        }
      } catch (error) {
        // Zero out key material on error
        myKeyPair.secretKey.fill(0)
        if (error instanceof SyncApiError) {
          throw new Error(error.message)
        }
        throw error
      }
    })
  )

  /**
   * T114 - Approve Linking (Existing Device)
   *
   * Called by existing device to approve a linking request.
   *
   * Flow:
   * 1. Verify we have an active session with scanned status
   * 2. Compute shared secret with new device's public key
   * 3. Derive linking keys
   * 4. Verify new_device_confirm HMAC
   * 5. Get master key from keychain
   * 6. Encrypt master key with encKey
   * 7. Compute key_confirm HMAC
   * 8. Call POST /auth/linking/{sessionId}/approve
   */
  ipcMain.handle(
    SYNC_CHANNELS.APPROVE_LINKING,
    createValidatedHandler(ApproveLinkingInputSchema, async (input) => {
      const { sessionId, newDevicePublicKey, newDeviceConfirm } = input

      // Verify we have an active session
      if (!activeLinkingSession || activeLinkingSession.sessionId !== sessionId) {
        throw new Error('No active linking session found')
      }

      // Check expiry
      if (Date.now() > activeLinkingSession.expiresAt) {
        // Clean up
        activeLinkingSession.ephemeralKeyPair.secretKey.fill(0)
        activeLinkingSession = null
        throw new Error('Linking session has expired')
      }

      // Get tokens for authenticated request
      const tokens = await getTokens()
      if (!tokens) {
        throw new Error('Not logged in')
      }

      // Parse new device's public key
      const newDevicePubKey = Buffer.from(newDevicePublicKey, 'base64')
      if (newDevicePubKey.length !== 32) {
        throw new Error('Invalid new device public key')
      }

      try {
        // Compute shared secret (T110)
        const sharedSecret = computeX25519SharedSecret(
          activeLinkingSession.ephemeralKeyPair.secretKey,
          newDevicePubKey
        )

        // Derive linking keys (T110)
        const linkingKeys = deriveLinkingKeys(sharedSecret)

        // Zero out shared secret
        sharedSecret.fill(0)

        // Verify new_device_confirm HMAC (T110a)
        const expectedHmac = Buffer.from(newDeviceConfirm, 'base64')
        const isValid = verifyNewDeviceConfirm(
          linkingKeys.macKey,
          expectedHmac,
          sessionId,
          activeLinkingSession.token,
          newDevicePublicKey
        )

        if (!isValid) {
          linkingKeys.encKey.fill(0)
          linkingKeys.macKey.fill(0)
          throw new Error('Invalid HMAC - linking verification failed')
        }

        // Store linking keys for potential future use
        activeLinkingSession.linkingKeys = linkingKeys
        activeLinkingSession.newDevicePublicKey = newDevicePubKey

        // Get master key from keychain
        const { getMasterKey } = await import('../crypto/keychain')
        const masterKey = await getMasterKey()
        if (!masterKey) {
          throw new Error('Master key not found in keychain')
        }

        // Encrypt master key (T111)
        const { ciphertext, nonce } = encryptMasterKeyForLinking(
          Buffer.from(masterKey),
          linkingKeys.encKey
        )

        const encryptedMasterKeyBase64 = ciphertext.toString('base64')
        const nonceBase64 = nonce.toString('base64')

        // Compute key_confirm HMAC (T110a)
        const keyConfirm = computeKeyConfirm(
          linkingKeys.macKey,
          sessionId,
          encryptedMasterKeyBase64,
          nonceBase64
        )

        // Call server to approve
        await syncApi.instance.approveLinking(
          sessionId,
          encryptedMasterKeyBase64,
          nonceBase64,
          keyConfirm.toString('base64'),
          tokens.accessToken
        )

        // Update session status
        activeLinkingSession.status = 'approved'

        // Clean up after a delay
        setTimeout(() => {
          if (activeLinkingSession?.sessionId === sessionId) {
            activeLinkingSession.ephemeralKeyPair.secretKey.fill(0)
            if (activeLinkingSession.linkingKeys) {
              activeLinkingSession.linkingKeys.encKey.fill(0)
              activeLinkingSession.linkingKeys.macKey.fill(0)
            }
            activeLinkingSession = null
          }
        }, 30 * 1000) // 30 seconds after approval

        return {
          success: true,
          message: 'Linking approved. New device is being set up.'
        }
      } catch (error) {
        if (error instanceof SyncApiError) {
          throw new Error(error.message)
        }
        throw error
      }
    })
  )

  /**
   * Complete Linking (New Device)
   *
   * Called by new device after approval to complete the linking process.
   *
   * Flow:
   * 1. Verify we have a pending request
   * 2. Call server to get encrypted master key
   * 3. Verify key_confirm HMAC
   * 4. Decrypt master key
   * 5. Store master key and tokens in keychain
   */
  ipcMain.handle(
    SYNC_CHANNELS.COMPLETE_LINKING,
    createValidatedHandler(CompleteLinkingInputSchema, async (input) => {
      const { sessionId } = input

      // Verify we have a pending request
      if (!pendingLinkingRequest || pendingLinkingRequest.sessionId !== sessionId) {
        throw new Error('No pending linking request found')
      }

      // Check expiry
      if (Date.now() > pendingLinkingRequest.expiresAt) {
        // Clean up
        pendingLinkingRequest.myKeyPair.secretKey.fill(0)
        pendingLinkingRequest.linkingKeys.encKey.fill(0)
        pendingLinkingRequest.linkingKeys.macKey.fill(0)
        pendingLinkingRequest = null
        throw new Error('Linking request has expired')
      }

      try {
        const myPublicKeyBase64 = pendingLinkingRequest.myKeyPair.publicKey.toString('base64')

        // Call server to complete linking
        const response = await syncApi.instance.completeLinking(sessionId, myPublicKeyBase64)

        // Verify key_confirm HMAC (T110a)
        const expectedHmac = Buffer.from(response.key_confirm, 'base64')
        const isValid = verifyKeyConfirm(
          pendingLinkingRequest.linkingKeys.macKey,
          expectedHmac,
          sessionId,
          response.encrypted_master_key,
          response.nonce
        )

        if (!isValid) {
          throw new Error('Invalid key confirmation - linking verification failed')
        }

        // Decrypt master key (T111)
        const encryptedMasterKey = Buffer.from(response.encrypted_master_key, 'base64')
        const nonce = Buffer.from(response.nonce, 'base64')
        const masterKey = decryptMasterKeyForLinking(
          encryptedMasterKey,
          nonce,
          pendingLinkingRequest.linkingKeys.encKey
        )

        // Save session to keychain
        const keychain = await import('../crypto/keychain')

        // Get user ID from device info
        const userId = await keychain.getUserId()

        await keychain.saveSyncSession({
          userId: userId || response.device.id, // Fallback to device ID if user ID not set
          deviceId: response.device.id,
          accessToken: response.tokens.accessToken,
          refreshToken: response.tokens.refreshToken,
          masterKey
        })

        // Clean up key material
        pendingLinkingRequest.myKeyPair.secretKey.fill(0)
        pendingLinkingRequest.linkingKeys.encKey.fill(0)
        pendingLinkingRequest.linkingKeys.macKey.fill(0)
        pendingLinkingRequest = null

        return {
          success: true,
          deviceId: response.device.id,
          message: 'Device linked successfully'
        }
      } catch (error) {
        // Clean up on error
        if (pendingLinkingRequest) {
          pendingLinkingRequest.myKeyPair.secretKey.fill(0)
          pendingLinkingRequest.linkingKeys.encKey.fill(0)
          pendingLinkingRequest.linkingKeys.macKey.fill(0)
          pendingLinkingRequest = null
        }
        if (error instanceof SyncApiError) {
          throw new Error(error.message)
        }
        throw error
      }
    })
  )

  /**
   * Cancel Linking
   *
   * Called by either device to cancel an active linking session.
   */
  ipcMain.handle(
    SYNC_CHANNELS.CANCEL_LINKING,
    createHandler(async () => {
      // Clean up existing device session
      if (activeLinkingSession) {
        const sessionId = activeLinkingSession.sessionId

        // Try to reject on server if we have tokens
        const tokens = await getTokens()
        if (tokens) {
          try {
            await syncApi.instance.rejectLinking(sessionId, tokens.accessToken)
          } catch {
            // Ignore errors - session might already be expired
          }
        }

        // Zero out key material
        activeLinkingSession.ephemeralKeyPair.secretKey.fill(0)
        if (activeLinkingSession.linkingKeys) {
          activeLinkingSession.linkingKeys.encKey.fill(0)
          activeLinkingSession.linkingKeys.macKey.fill(0)
        }
        activeLinkingSession = null
      }

      // Clean up new device pending request
      if (pendingLinkingRequest) {
        pendingLinkingRequest.myKeyPair.secretKey.fill(0)
        pendingLinkingRequest.linkingKeys.encKey.fill(0)
        pendingLinkingRequest.linkingKeys.macKey.fill(0)
        pendingLinkingRequest = null
      }

      return { success: true }
    })
  )

  /**
   * Get Linking Status
   *
   * Returns the current linking session status for either device.
   */
  ipcMain.handle(
    SYNC_CHANNELS.GET_LINKING_STATUS,
    createHandler(async () => {
      // Check for active session (existing device)
      if (activeLinkingSession) {
        const isExpired = Date.now() > activeLinkingSession.expiresAt

        if (isExpired) {
          // Clean up expired session
          activeLinkingSession.ephemeralKeyPair.secretKey.fill(0)
          if (activeLinkingSession.linkingKeys) {
            activeLinkingSession.linkingKeys.encKey.fill(0)
            activeLinkingSession.linkingKeys.macKey.fill(0)
          }
          activeLinkingSession = null
          return { status: 'none', session: null }
        }

        return {
          status: activeLinkingSession.status,
          session: {
            sessionId: activeLinkingSession.sessionId,
            expiresAt: activeLinkingSession.expiresAt,
            deviceName: activeLinkingSession.deviceName,
            devicePlatform: activeLinkingSession.devicePlatform
          },
          role: 'existing'
        }
      }

      // Check for pending request (new device)
      if (pendingLinkingRequest) {
        const isExpired = Date.now() > pendingLinkingRequest.expiresAt

        if (isExpired) {
          // Clean up expired request
          pendingLinkingRequest.myKeyPair.secretKey.fill(0)
          pendingLinkingRequest.linkingKeys.encKey.fill(0)
          pendingLinkingRequest.linkingKeys.macKey.fill(0)
          pendingLinkingRequest = null
          return { status: 'none', session: null }
        }

        return {
          status: 'waiting_approval',
          session: {
            sessionId: pendingLinkingRequest.sessionId,
            expiresAt: pendingLinkingRequest.expiresAt
          },
          role: 'new'
        }
      }

      return { status: 'none', session: null }
    })
  )

  // ---------------------------------------------------------------------------
  // Device Linking (Recovery Phrase)
  // ---------------------------------------------------------------------------

  /**
   * Link via Recovery Phrase
   *
   * Used when adding a new device to an existing account.
   * Requires the user to enter their recovery phrase to derive keys.
   */
  ipcMain.handle(
    SYNC_CHANNELS.LINK_VIA_RECOVERY,
    createValidatedHandler(LinkViaRecoveryInputSchema, async (input) => {
      const { recoveryPhrase, email, deviceName } = input

      // Validate recovery phrase
      const validation = validateRecoveryPhrase(recoveryPhrase)
      if (!validation.valid) {
        throw new Error(`Invalid recovery phrase: ${validation.error}`)
      }

      try {
        // Get recovery data (kdf_salt and key_verifier) using email
        const recoveryData = await syncApi.instance.getRecoveryData(email)

        // Derive seed from recovery phrase
        const seed = await mnemonicToSeed(recoveryPhrase)

        // Derive master key using stored KDF salt
        const kdfSalt = Buffer.from(recoveryData.kdf_salt, 'base64')
        const masterKey = deriveMasterKey(seed, kdfSalt)

        // Verify against stored key verifier
        const expectedVerifier = Buffer.from(recoveryData.key_verifier, 'base64')
        if (!verifyKeyVerifier(masterKey, expectedVerifier)) {
          throw new Error('Recovery phrase does not match. Please check and try again.')
        }

        // Get tokens from keychain (set during login)
        const tokens = await getTokens()
        if (!tokens) {
          throw new Error('No authentication tokens found. Please try logging in again.')
        }

        // Get user ID from keychain
        const userId = await getUserId()
        if (!userId) {
          throw new Error('User ID not found. Please try logging in again.')
        }

        // Register device with server
        const device = await syncApi.instance.registerDevice(
          deviceName,
          getDevicePlatform(),
          app.getVersion(),
          tokens.accessToken,
          os.release()
        )

        // Save complete session to keychain (including master key)
        // Use NEW tokens from device registration (contain real device ID, not temp ID)
        await saveSyncSession({
          userId,
          deviceId: device.id,
          accessToken: device.tokens.access_token,
          refreshToken: device.tokens.refresh_token,
          masterKey
        })

        return {
          success: true,
          deviceId: device.id
        }
      } catch (error) {
        if (error instanceof SyncApiError) {
          throw new Error(error.message)
        }
        throw error
      }
    })
  )

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  ipcMain.handle(
    SYNC_CHANNELS.GET_SYNCED_SETTINGS,
    createHandler(async () => {
      // TODO: Implement in Phase 4+ (P2 MVP)
      return { settings: {} }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.UPDATE_SYNCED_SETTINGS,
    createHandler(async () => {
      // TODO: Implement in Phase 4+ (P2 MVP)
      throw new Error('Not implemented: UPDATE_SYNCED_SETTINGS')
    })
  )

  console.log('[IPC] Sync handlers registered')
}

/**
 * Unregister all sync-related IPC handlers.
 */
export function unregisterSyncHandlers(): void {
  Object.values(SYNC_CHANNELS).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })

  clearPendingSignup()
  pendingOAuth = null

  // Clean up linking state
  if (activeLinkingSession) {
    activeLinkingSession.ephemeralKeyPair.secretKey.fill(0)
    if (activeLinkingSession.linkingKeys) {
      activeLinkingSession.linkingKeys.encKey.fill(0)
      activeLinkingSession.linkingKeys.macKey.fill(0)
    }
    activeLinkingSession = null
  }

  if (pendingLinkingRequest) {
    pendingLinkingRequest.myKeyPair.secretKey.fill(0)
    pendingLinkingRequest.linkingKeys.encKey.fill(0)
    pendingLinkingRequest.linkingKeys.macKey.fill(0)
    pendingLinkingRequest = null
  }

  console.log('[IPC] Sync handlers unregistered')
}

// =============================================================================
// Event Emitters (for main -> renderer communication)
// =============================================================================

/**
 * Emit sync status changed event to all renderer windows.
 */
export function emitSyncStatusChanged(webContents: Electron.WebContents, status: SyncStatus): void {
  webContents.send(SYNC_EVENTS.STATUS_CHANGED, { status })
}

/**
 * Emit item synced event to all renderer windows.
 */
export function emitItemSynced(
  webContents: Electron.WebContents,
  event: {
    itemId: string
    type: 'note' | 'task' | 'project' | 'settings' | 'attachment'
    operation: 'create' | 'update' | 'delete'
  }
): void {
  webContents.send(SYNC_EVENTS.ITEM_SYNCED, event)
}

/**
 * Emit sync error event to all renderer windows.
 */
export function emitSyncError(
  webContents: Electron.WebContents,
  event: { error: string; itemId?: string; recoverable: boolean }
): void {
  webContents.send(SYNC_EVENTS.SYNC_ERROR, event)
}

/**
 * Emit device linking request event.
 */
export function emitLinkingRequest(
  webContents: Electron.WebContents,
  event: { sessionId: string; deviceName: string; devicePlatform: string }
): void {
  webContents.send(SYNC_EVENTS.LINKING_REQUEST, event)
}

/**
 * Emit session expired event.
 */
export function emitSessionExpired(
  webContents: Electron.WebContents,
  reason: 'token_expired' | 'device_removed' | 'key_rotated'
): void {
  webContents.send(SYNC_EVENTS.SESSION_EXPIRED, { reason })
}
