/**
 * Sync API Client
 *
 * HTTP client for communicating with the sync server.
 * Handles all authentication and sync-related API calls.
 *
 * @module main/sync/api-client
 */

// =============================================================================
// Configuration
// =============================================================================

import { BrowserWindow } from 'electron'
import { SYNC_EVENTS } from '@shared/contracts/ipc-sync'
import { getTokens, saveTokens } from '../crypto/keychain'

/**
 * Get sync server URL at runtime (lazy evaluation)
 *
 * This must be a function, not a constant, because:
 * - Constants are evaluated at bundle time (before dotenv loads)
 * - Functions are evaluated at runtime (after dotenv loads)
 */
function getServerUrl(): string {
  return process.env.SYNC_SERVER_URL || 'https://api.memry.app'
}

/** API version prefix */
const API_PREFIX = '/api/v1'

// =============================================================================
// Types
// =============================================================================

/** API error response */
export interface ApiError {
  error: string
  message: string
  details?: Record<string, unknown>
}

/** Auth result from login/signup */
export interface AuthResult {
  user: {
    id: string
    email: string
    emailVerified: boolean
    authMethod: 'email' | 'oauth'
    authProvider?: 'google'
    storageUsed: number
    storageLimit: number
    createdAt: string
  }
  tokens: {
    accessToken: string
    refreshToken: string
    expiresIn: number
  }
  isNewUser: boolean
  needsDeviceSetup: boolean
}

/** Public device info */
export interface DevicePublic {
  id: string
  name: string
  platform: string
  osVersion?: string
  appVersion: string
  createdAt: string
  lastSyncAt?: string
}

/** Device registration response (includes new tokens with real device ID) */
export interface DeviceRegistrationResponse extends DevicePublic {
  tokens: {
    access_token: string
    refresh_token: string
    expires_in: number
  }
}

/** Recovery data for device linking */
export interface RecoveryData {
  kdf_salt: string
  key_verifier: string
}

/** Signup response */
export interface SignupResponse {
  message: string
  user_id: string
}

/** Simple message response */
export interface MessageResponse {
  message: string
}

/** Token refresh response */
export interface RefreshResponse {
  access_token: string
  expires_in: number
}

/** Linking session initiation response (T104) */
export interface LinkingSessionResponse {
  session_id: string
  token: string
  expires_at: string
}

/** Linking complete response (T107) */
export interface LinkingCompleteResponse {
  encrypted_master_key: string
  nonce: string
  key_confirm: string
  device: DevicePublic
  tokens: {
    accessToken: string
    refreshToken: string
    expiresIn: number
  }
}

/** Linking status response */
export interface LinkingStatusResponse {
  status: 'pending' | 'scanned' | 'approved' | 'completed' | 'rejected' | 'expired'
  new_device_public_key?: string
  new_device_confirm?: string
  device_name?: string
  device_platform?: string
  expires_at: string
  server_timestamp: number
}

// =============================================================================
// API Client Class
// =============================================================================

/**
 * Sync Server API Client
 *
 * Provides typed methods for all sync server endpoints.
 */
export class SyncApiClient {
  private readonly baseUrl: string

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? getServerUrl()
  }

  // ---------------------------------------------------------------------------
  // Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Make an HTTP request to the API
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    options: {
      body?: Record<string, unknown>
      token?: string
      query?: Record<string, string>
      skipRefresh?: boolean
    } = {}
  ): Promise<T> {
    const url = new URL(`${API_PREFIX}${endpoint}`, this.baseUrl)

    // Add query parameters
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value)
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }

    // Add authorization header if token provided
    if (options.token) {
      headers['Authorization'] = `Bearer ${options.token}`
    }

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    })

    const data = await response.json()

    if (!response.ok) {
      const error = data as ApiError
      const syncError = new SyncApiError(
        error.error || 'UNKNOWN_ERROR',
        error.message || 'Unknown error',
        response.status
      )

      if (!options.skipRefresh && options.token && syncError.isAuthError()) {
        const tokens = await getTokens()
        if (tokens?.refreshToken) {
          try {
            const refresh = await this.refreshToken(tokens.refreshToken)
            await saveTokens(refresh.access_token, tokens.refreshToken)
            return this.request<T>(method, endpoint, {
              ...options,
              token: refresh.access_token,
              skipRefresh: true
            })
          } catch {
            BrowserWindow.getAllWindows().forEach((win) => {
              win.webContents.send(SYNC_EVENTS.SESSION_EXPIRED, { reason: 'token_expired' })
            })
          }
        } else {
          BrowserWindow.getAllWindows().forEach((win) => {
            win.webContents.send(SYNC_EVENTS.SESSION_EXPIRED, { reason: 'token_expired' })
          })
        }
      }

      throw syncError
    }

    return data as T
  }

  // ---------------------------------------------------------------------------
  // Email Auth Endpoints
  // ---------------------------------------------------------------------------

  /**
   * Sign up with email and password
   *
   * @param email - User email
   * @param password - User password (min 12 chars)
   * @returns Signup response with user ID
   */
  async emailSignup(email: string, password: string): Promise<SignupResponse> {
    return this.request<SignupResponse>('POST', '/auth/email/signup', {
      body: { email, password }
    })
  }

  /**
   * Verify email with token
   *
   * @param token - Email verification token
   * @returns Auth result with tokens
   */
  async emailVerify(token: string): Promise<AuthResult> {
    return this.request<AuthResult>('POST', '/auth/email/verify', {
      body: { token }
    })
  }

  /**
   * Login with email and password
   *
   * @param email - User email
   * @param password - User password
   * @returns Auth result with tokens
   */
  async emailLogin(email: string, password: string): Promise<AuthResult> {
    return this.request<AuthResult>('POST', '/auth/email/login', {
      body: { email, password }
    })
  }

  /**
   * Request password reset email
   *
   * @param email - User email
   * @returns Success message (always succeeds for security)
   */
  async forgotPassword(email: string): Promise<MessageResponse> {
    return this.request<MessageResponse>('POST', '/auth/email/forgot-password', {
      body: { email }
    })
  }

  /**
   * Reset password with token
   *
   * @param token - Password reset token
   * @param newPassword - New password (min 12 chars)
   * @returns Success message
   */
  async resetPassword(token: string, newPassword: string): Promise<MessageResponse> {
    return this.request<MessageResponse>('POST', '/auth/email/reset-password', {
      body: { token, new_password: newPassword }
    })
  }

  /**
   * Change password (authenticated)
   *
   * @param currentPassword - Current password
   * @param newPassword - New password (min 12 chars)
   * @param accessToken - JWT access token
   * @returns Success message
   */
  async changePassword(
    currentPassword: string,
    newPassword: string,
    accessToken: string
  ): Promise<MessageResponse> {
    return this.request<MessageResponse>('POST', '/auth/email/change-password', {
      body: { current_password: currentPassword, new_password: newPassword },
      token: accessToken
    })
  }

  /**
   * Resend verification email
   *
   * @param email - User email
   * @returns Success message (always succeeds for security)
   */
  async resendVerification(email: string): Promise<MessageResponse> {
    return this.request<MessageResponse>('POST', '/auth/email/resend-verification', {
      body: { email }
    })
  }

  // ---------------------------------------------------------------------------
  // Token Endpoints
  // ---------------------------------------------------------------------------

  /**
   * Refresh access token
   *
   * @param refreshToken - JWT refresh token
   * @returns New access token and expiry
   */
  async refreshToken(refreshToken: string): Promise<RefreshResponse> {
    return this.request<RefreshResponse>('POST', '/auth/refresh', {
      body: { refresh_token: refreshToken }
    })
  }

  // ---------------------------------------------------------------------------
  // OAuth Endpoints
  // ---------------------------------------------------------------------------

  /**
   * Get OAuth authorization URL
   *
   * @param provider - OAuth provider (google)
   * @param redirectUri - Redirect URI after auth
   * @param state - CSRF state token
   * @param codeChallenge - PKCE code challenge
   * @returns Authorization URL to redirect to
   */
  getOAuthUrl(
    provider: 'google',
    redirectUri: string,
    state: string,
    codeChallenge: string
  ): string {
    const params = new URLSearchParams({
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    })

    return `${this.baseUrl}${API_PREFIX}/auth/oauth/${provider}?${params.toString()}`
  }

  /**
   * Exchange OAuth code for auth result
   *
   * @param provider - OAuth provider
   * @param code - Authorization code
   * @param state - CSRF state token
   * @param codeVerifier - PKCE code verifier
   * @param redirectUri - The redirect URI used in the authorization request
   * @returns Auth result with tokens
   */
  async oauthCallback(
    provider: 'google',
    code: string,
    state: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<AuthResult> {
    return this.request<AuthResult>('POST', `/auth/oauth/${provider}/callback`, {
      body: { code, state, code_verifier: codeVerifier, redirect_uri: redirectUri }
    })
  }

  // ---------------------------------------------------------------------------
  // Device Endpoints
  // ---------------------------------------------------------------------------

  /**
   * Register a device (authenticated)
   *
   * @param name - Device name
   * @param platform - Device platform
   * @param appVersion - App version
   * @param accessToken - JWT access token
   * @param osVersion - Optional OS version
   * @param authPublicKey - Optional Ed25519 public key
   * @returns Registered device info with new tokens
   */
  async registerDevice(
    name: string,
    platform: 'macos' | 'windows' | 'linux' | 'ios' | 'android',
    appVersion: string,
    accessToken: string,
    osVersion?: string,
    authPublicKey?: string
  ): Promise<DeviceRegistrationResponse> {
    return this.request<DeviceRegistrationResponse>('POST', '/auth/device/register', {
      body: {
        name,
        platform,
        app_version: appVersion,
        os_version: osVersion,
        auth_public_key: authPublicKey
      },
      token: accessToken
    })
  }

  /**
   * Setup first device (store KDF salt and key verifier)
   *
   * @param kdfSalt - Base64-encoded KDF salt
   * @param keyVerifier - Base64-encoded key verifier
   * @param accessToken - JWT access token
   * @returns Success message
   */
  async setupDevice(
    kdfSalt: string,
    keyVerifier: string,
    accessToken: string
  ): Promise<MessageResponse> {
    return this.request<MessageResponse>('POST', '/auth/device/setup', {
      body: { kdf_salt: kdfSalt, key_verifier: keyVerifier },
      token: accessToken
    })
  }

  // ---------------------------------------------------------------------------
  // Recovery Endpoints
  // ---------------------------------------------------------------------------

  /**
   * Get recovery data for a user (KDF salt and key verifier)
   *
   * @param userId - User ID or email
   * @returns KDF salt and key verifier for key derivation
   */
  async getRecoveryData(userId: string): Promise<RecoveryData> {
    return this.request<RecoveryData>('GET', '/auth/recovery', {
      query: { user_id: userId }
    })
  }

  // ---------------------------------------------------------------------------
  // Device Linking Endpoints (T104-T108, T112-T114)
  // ---------------------------------------------------------------------------

  /**
   * Initiate a device linking session (T104, T112)
   *
   * Called by existing device to start linking process.
   *
   * @param ephemeralPublicKey - Base64-encoded X25519 public key
   * @param accessToken - JWT access token
   * @returns Session info for QR code
   */
  async initiateLinking(
    ephemeralPublicKey: string,
    accessToken: string
  ): Promise<LinkingSessionResponse> {
    return this.request<LinkingSessionResponse>('POST', '/auth/linking/initiate', {
      body: { ephemeral_public_key: ephemeralPublicKey },
      token: accessToken
    })
  }

  /**
   * Scan linking QR code (T105, T113)
   *
   * Called by new device after scanning QR.
   *
   * @param sessionId - Linking session ID
   * @param token - One-time token from QR code
   * @param newDevicePublicKey - Base64-encoded X25519 public key
   * @param newDeviceConfirm - Base64-encoded HMAC proof
   * @param deviceName - Name for the new device
   * @param devicePlatform - Platform of the new device
   * @returns Success response
   */
  async scanLinkingQR(
    sessionId: string,
    token: string,
    newDevicePublicKey: string,
    newDeviceConfirm: string,
    deviceName: string,
    devicePlatform: 'macos' | 'windows' | 'linux' | 'ios' | 'android'
  ): Promise<MessageResponse> {
    return this.request<MessageResponse>('POST', `/auth/linking/${sessionId}/scan`, {
      body: {
        new_device_public_key: newDevicePublicKey,
        token,
        new_device_confirm: newDeviceConfirm,
        device_name: deviceName,
        device_platform: devicePlatform
      }
    })
  }

  /**
   * Approve device linking (T106, T114)
   *
   * Called by existing device to approve and send encrypted master key.
   *
   * @param sessionId - Linking session ID
   * @param encryptedMasterKey - Base64-encoded encrypted master key
   * @param nonce - Base64-encoded encryption nonce
   * @param keyConfirm - Base64-encoded HMAC proof
   * @param accessToken - JWT access token
   * @returns Success response
   */
  async approveLinking(
    sessionId: string,
    encryptedMasterKey: string,
    nonce: string,
    keyConfirm: string,
    accessToken: string
  ): Promise<MessageResponse> {
    return this.request<MessageResponse>('POST', `/auth/linking/${sessionId}/approve`, {
      body: {
        encrypted_master_key: encryptedMasterKey,
        nonce,
        key_confirm: keyConfirm
      },
      token: accessToken
    })
  }

  /**
   * Complete device linking (T107, T113)
   *
   * Called by new device to retrieve encrypted master key and register device.
   *
   * @param sessionId - Linking session ID
   * @param newDevicePublicKey - Base64-encoded X25519 public key (for verification)
   * @returns Encrypted master key and auth tokens
   */
  async completeLinking(
    sessionId: string,
    newDevicePublicKey: string
  ): Promise<LinkingCompleteResponse> {
    return this.request<LinkingCompleteResponse>('POST', `/auth/linking/${sessionId}/complete`, {
      body: { new_device_public_key: newDevicePublicKey }
    })
  }

  /**
   * Reject device linking (T108)
   *
   * Called by existing device to reject the linking request.
   *
   * @param sessionId - Linking session ID
   * @param accessToken - JWT access token
   * @returns Success response
   */
  async rejectLinking(sessionId: string, accessToken: string): Promise<MessageResponse> {
    return this.request<MessageResponse>('POST', `/auth/linking/${sessionId}/reject`, {
      token: accessToken
    })
  }

  /**
   * Get linking session status
   *
   * @param sessionId - Linking session ID
   * @param auth - Authentication: either { accessToken } for existing device or { qrToken } for new device
   * @returns Session status
   */
  async getLinkingStatus(
    sessionId: string,
    auth?: { accessToken: string } | { qrToken: string }
  ): Promise<LinkingStatusResponse> {
    // Determine auth method
    let token: string | undefined
    let queryParams = ''

    if (auth && 'accessToken' in auth) {
      token = auth.accessToken
    } else if (auth && 'qrToken' in auth) {
      queryParams = `?token=${encodeURIComponent(auth.qrToken)}`
    }

    return this.request<LinkingStatusResponse>(
      'GET',
      `/auth/linking/${sessionId}/status${queryParams}`,
      { token }
    )
  }
}

// =============================================================================
// Error Class
// =============================================================================

/**
 * API Error
 *
 * Custom error class for sync API errors.
 */
export class SyncApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number
  ) {
    super(message)
    this.name = 'SyncApiError'
  }

  /** Check if error is due to authentication */
  isAuthError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403
  }

  /** Check if error is due to validation */
  isValidationError(): boolean {
    return this.statusCode === 400 || this.code === 'VALIDATION_ERROR'
  }

  /** Check if error is due to conflict (e.g., email already exists) */
  isConflictError(): boolean {
    return this.statusCode === 409 || this.code === 'CONFLICT_ERROR'
  }

  /** Check if error is due to not found */
  isNotFoundError(): boolean {
    return this.statusCode === 404 || this.code === 'NOT_FOUND_ERROR'
  }
}

// =============================================================================
// Singleton Instance (Lazy)
// =============================================================================

/** Cached API client instance */
let _syncApiInstance: SyncApiClient | null = null

/**
 * Lazy singleton API client
 *
 * Uses a getter to defer instantiation until first access,
 * which happens after dotenv has loaded environment variables.
 */
export const syncApi = {
  get instance(): SyncApiClient {
    if (!_syncApiInstance) {
      _syncApiInstance = new SyncApiClient()
    }
    return _syncApiInstance
  }
}
