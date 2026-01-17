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
  verifyKeyVerifier
} from '../crypto/keys'
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
  provider: 'google' | 'apple' | 'github'
  deviceName: string
  state: string
  codeVerifier: string
  redirectUri: string
  closeServer?: () => void
}

// =============================================================================
// State (in-memory during signup flow)
// =============================================================================

/** Temporary state during signup flow (cleared after completion or timeout) */
let pendingSignup: SignupState | null = null
let signupTimeout: NodeJS.Timeout | null = null

/** Temporary state during OAuth flow */
let pendingOAuth: OAuthState | null = null

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
        const userId = await getUserId()
        if (!userId) {
          throw new Error('User ID not found in keychain')
        }

        await saveSyncSession({
          userId,
          deviceId: device.id,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
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

  ipcMain.handle(
    SYNC_CHANNELS.TRIGGER_SYNC,
    createValidatedHandler(TriggerSyncInputSchema, async (_input) => {
      // TODO: Implement in Phase 3+ (User Story 3)
      return { success: true, message: 'Sync not yet implemented' }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.PAUSE_SYNC,
    createHandler(async () => {
      // TODO: Implement in Phase 3+
      return { success: true }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.RESUME_SYNC,
    createHandler(async () => {
      // TODO: Implement in Phase 3+
      return { success: true }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.GET_QUEUE_SIZE,
    createHandler(async () => {
      // TODO: Implement in Phase 3+
      return { size: 0 }
    })
  )

  // ---------------------------------------------------------------------------
  // Sync History
  // ---------------------------------------------------------------------------

  ipcMain.handle(
    SYNC_CHANNELS.GET_HISTORY,
    createValidatedHandler(GetHistoryInputSchema, async (_input) => {
      // TODO: Implement in Phase 3+
      return { entries: [], total: 0, hasMore: false }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.CLEAR_HISTORY,
    createHandler(async () => {
      // TODO: Implement in Phase 3+
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

  ipcMain.handle(
    SYNC_CHANNELS.GENERATE_LINKING_QR,
    createHandler(async () => {
      // TODO: Implement in Phase 3 (User Story 4)
      throw new Error('Not implemented: GENERATE_LINKING_QR')
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.LINK_VIA_QR,
    createValidatedHandler(LinkViaQRInputSchema, async (_input) => {
      // TODO: Implement in Phase 3 (User Story 4)
      throw new Error('Not implemented: LINK_VIA_QR')
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.APPROVE_LINKING,
    createValidatedHandler(ApproveLinkingInputSchema, async (_input) => {
      // TODO: Implement in Phase 3 (User Story 4)
      throw new Error('Not implemented: APPROVE_LINKING')
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.CANCEL_LINKING,
    createHandler(async () => {
      // TODO: Implement in Phase 3 (User Story 4)
      return { success: true }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.GET_LINKING_STATUS,
    createHandler(async () => {
      // TODO: Implement in Phase 3 (User Story 4)
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
        await saveSyncSession({
          userId,
          deviceId: device.id,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
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
