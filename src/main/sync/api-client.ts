/**
 * Sync Server API Client
 *
 * HTTP client for communicating with the sync server.
 * Handles authentication, token refresh, and all sync-related API calls.
 *
 * @module sync/api-client
 */

import { z } from 'zod'
import type {
  OtpRequest,
  OtpRequestResponse,
  OtpVerifyRequest,
  OtpVerifyResponse,
  OtpResendRequest,
  OtpResendResponse,
  FirstDeviceSetupRequest,
  FirstDeviceSetupResponse,
  DeviceRegisterRequest,
  DeviceRegisterResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
  RecoveryInfoResponse,
  OAuthCallbackResponse,
  LogoutRequest,
  LogoutResponse,
  GetDevicesResponse
} from '@shared/contracts/auth-api'
import type {
  LinkingInitiateRequest,
  LinkingInitiateResponse,
  LinkingScanRequest,
  LinkingScanResponse,
  LinkingApproveRequest,
  LinkingApproveResponse,
  LinkingCompleteRequest,
  LinkingCompleteResponse,
  LinkingStatusResponse
} from '@shared/contracts/linking-api'
import type {
  SyncItemPush,
  PushSyncResponse,
  PullSyncResponse,
  SyncStatusResponse,
  VectorClock
} from '@shared/contracts/sync-api'
import { retrieveAuthTokens } from '../crypto/keychain'

export class SyncApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message)
    this.name = 'SyncApiError'
  }
}

function getSyncServerUrl(): string {
  const url = process.env.SYNC_SERVER_URL
  if (!url && process.env.NODE_ENV === 'production') {
    throw new Error('SYNC_SERVER_URL environment variable is required in production')
  }
  return url || 'http://localhost:8787'
}

const ErrorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  code: z.string().optional()
})

function parseErrorBody(
  value: unknown
): { error?: string; message?: string; code?: string } | null {
  const result = ErrorBodySchema.safeParse(value)
  return result.success ? result.data : null
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`
    let errorCode: string | undefined
    try {
      const errorBody: unknown = await response.json()
      const parsed = parseErrorBody(errorBody)
      if (parsed) {
        errorMessage = parsed.error ?? parsed.message ?? errorMessage
        errorCode = parsed.code
      }
    } catch {
      errorMessage = response.statusText || errorMessage
    }
    throw new SyncApiError(errorMessage, response.status, errorCode)
  }
  return response.json() as Promise<T>
}

export interface OAuthInitiateParams {
  redirectUri: string
  codeChallenge: string
  state: string
}

export interface OAuthInitiateResponse {
  authUrl: string
}

export interface OAuthExchangeParams {
  code: string
  codeVerifier: string
  redirectUri: string
  state: string
}

export interface SyncApiClient {
  requestOtp(email: string): Promise<OtpRequestResponse>
  verifyOtp(email: string, code: string): Promise<OtpVerifyResponse>
  resendOtp(email: string): Promise<OtpResendResponse>
  setupFirstDevice(
    token: string,
    request: FirstDeviceSetupRequest
  ): Promise<FirstDeviceSetupResponse>
  registerDevice(token: string, request: DeviceRegisterRequest): Promise<DeviceRegisterResponse>
  refreshToken(refreshToken: string): Promise<RefreshTokenResponse>
  getRecoveryInfo(token: string): Promise<RecoveryInfoResponse>
  getAccountDevices(token: string): Promise<GetDevicesResponse>
  initiateOAuth(provider: string, params: OAuthInitiateParams): Promise<OAuthInitiateResponse>
  exchangeOAuthCode(provider: string, params: OAuthExchangeParams): Promise<OAuthCallbackResponse>
  logout(token: string, request?: LogoutRequest): Promise<LogoutResponse>
  pushItems(items: SyncItemPush[], deviceClock: VectorClock): Promise<PushSyncResponse>
  pullItems(cursor: number, limit?: number): Promise<PullSyncResponse>
  getSyncStatus(): Promise<SyncStatusResponse>
  initiateLinking(token: string, deviceId: string, ephemeralPublicKey: string): Promise<LinkingInitiateResponse>
  scanLinking(request: LinkingScanRequest): Promise<LinkingScanResponse>
  approveLinking(token: string, request: LinkingApproveRequest): Promise<LinkingApproveResponse>
  completeLinking(request: LinkingCompleteRequest): Promise<LinkingCompleteResponse>
  getLinkingStatus(token: string, sessionId: string): Promise<LinkingStatusResponse>
  getLinkingStatusWithToken(sessionId: string, linkingToken: string): Promise<LinkingStatusResponse>
}

let clientInstance: SyncApiClient | null = null

function createApiClientInternal(baseUrl: string): SyncApiClient {

  return {
    async requestOtp(email: string): Promise<OtpRequestResponse> {
      const request: OtpRequest = { email }
      const response = await fetch(`${baseUrl}/api/v1/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      })
      return handleResponse<OtpRequestResponse>(response)
    },

    async verifyOtp(email: string, code: string): Promise<OtpVerifyResponse> {
      const request: OtpVerifyRequest = { email, code }
      const response = await fetch(`${baseUrl}/api/v1/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      })
      return handleResponse<OtpVerifyResponse>(response)
    },

    async resendOtp(email: string): Promise<OtpResendResponse> {
      const request: OtpResendRequest = { email }
      const response = await fetch(`${baseUrl}/api/v1/auth/otp/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      })
      return handleResponse<OtpResendResponse>(response)
    },

    async setupFirstDevice(
      token: string,
      request: FirstDeviceSetupRequest
    ): Promise<FirstDeviceSetupResponse> {
      const response = await fetch(`${baseUrl}/api/v1/auth/setup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(request)
      })
      return handleResponse<FirstDeviceSetupResponse>(response)
    },

    async registerDevice(
      token: string,
      request: DeviceRegisterRequest
    ): Promise<DeviceRegisterResponse> {
      const response = await fetch(`${baseUrl}/api/v1/auth/devices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(request)
      })
      return handleResponse<DeviceRegisterResponse>(response)
    },

    async refreshToken(refreshToken: string): Promise<RefreshTokenResponse> {
      const request: RefreshTokenRequest = { refreshToken }
      const response = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      })
      return handleResponse<RefreshTokenResponse>(response)
    },

    async getRecoveryInfo(token: string): Promise<RecoveryInfoResponse> {
      const response = await fetch(`${baseUrl}/api/v1/auth/recovery`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`
        }
      })
      return handleResponse<RecoveryInfoResponse>(response)
    },

    async getAccountDevices(token: string): Promise<GetDevicesResponse> {
      const response = await fetch(`${baseUrl}/api/v1/auth/devices`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`
        }
      })
      return handleResponse<GetDevicesResponse>(response)
    },

    async initiateOAuth(
      provider: string,
      params: OAuthInitiateParams
    ): Promise<OAuthInitiateResponse> {
      const searchParams = new URLSearchParams({
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
        code_challenge_method: 'S256',
        state: params.state
      })
      const response = await fetch(`${baseUrl}/api/v1/auth/oauth/${provider}?${searchParams}`, {
        method: 'GET'
      })
      return handleResponse<OAuthInitiateResponse>(response)
    },

    async exchangeOAuthCode(
      provider: string,
      params: OAuthExchangeParams
    ): Promise<OAuthCallbackResponse> {
      const response = await fetch(`${baseUrl}/api/v1/auth/oauth/${provider}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: params.code,
          state: params.state,
          code_verifier: params.codeVerifier,
          redirect_uri: params.redirectUri
        })
      })
      return handleResponse<OAuthCallbackResponse>(response)
    },

    async logout(token: string, request?: LogoutRequest): Promise<LogoutResponse> {
      const response = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(request ?? {})
      })
      return handleResponse<LogoutResponse>(response)
    },

    async pushItems(items: SyncItemPush[], deviceClock: VectorClock): Promise<PushSyncResponse> {
      const tokens = await retrieveAuthTokens()
      if (!tokens) {
        throw new SyncApiError('Not authenticated', 401, 'UNAUTHORIZED')
      }

      console.info('[SyncApi] Push request:', { itemCount: items.length })

      const response = await fetch(`${baseUrl}/api/v1/sync/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.accessToken}`
        },
        body: JSON.stringify({ items, deviceClock })
      })
      return handleResponse<PushSyncResponse>(response)
    },

    async pullItems(cursor: number, limit?: number): Promise<PullSyncResponse> {
      const tokens = await retrieveAuthTokens()
      if (!tokens) {
        throw new SyncApiError('Not authenticated', 401, 'UNAUTHORIZED')
      }

      const params = new URLSearchParams({ cursor: cursor.toString() })
      if (limit) {
        params.set('limit', limit.toString())
      }

      console.info('[SyncApi] Pull request:', { cursor, limit })

      const response = await fetch(`${baseUrl}/api/v1/sync/changes?${params}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`
        }
      })
      return handleResponse<PullSyncResponse>(response)
    },

    async getSyncStatus(): Promise<SyncStatusResponse> {
      const tokens = await retrieveAuthTokens()
      if (!tokens) {
        throw new SyncApiError('Not authenticated', 401, 'UNAUTHORIZED')
      }

      const response = await fetch(`${baseUrl}/api/v1/sync/status`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`
        }
      })
      return handleResponse<SyncStatusResponse>(response)
    },

    async initiateLinking(
      token: string,
      deviceId: string,
      ephemeralPublicKey: string
    ): Promise<LinkingInitiateResponse> {
      const request: LinkingInitiateRequest = { deviceId, ephemeralPublicKey }
      const response = await fetch(`${baseUrl}/api/v1/auth/linking/initiate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(request)
      })
      return handleResponse<LinkingInitiateResponse>(response)
    },

    /**
     * Submit QR scan from new device.
     *
     * This endpoint intentionally does not require an Authorization header
     * because the new device doesn't have tokens yet. Authentication is provided by:
     * 1. The `token` field from the QR code (single-use, time-limited)
     * 2. The `newDeviceConfirm` HMAC proof (proves possession of derived keys)
     */
    async scanLinking(request: LinkingScanRequest): Promise<LinkingScanResponse> {
      const response = await fetch(`${baseUrl}/api/v1/auth/linking/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      })
      return handleResponse<LinkingScanResponse>(response)
    },

    async approveLinking(
      token: string,
      request: LinkingApproveRequest
    ): Promise<LinkingApproveResponse> {
      const response = await fetch(`${baseUrl}/api/v1/auth/linking/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(request)
      })
      return handleResponse<LinkingApproveResponse>(response)
    },

    async completeLinking(request: LinkingCompleteRequest): Promise<LinkingCompleteResponse> {
      const response = await fetch(`${baseUrl}/api/v1/auth/linking/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      })
      return handleResponse<LinkingCompleteResponse>(response)
    },

    async getLinkingStatus(token: string, sessionId: string): Promise<LinkingStatusResponse> {
      const response = await fetch(`${baseUrl}/api/v1/auth/linking/${sessionId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`
        }
      })
      return handleResponse<LinkingStatusResponse>(response)
    },

    async getLinkingStatusWithToken(sessionId: string, linkingToken: string): Promise<LinkingStatusResponse> {
      const response = await fetch(`${baseUrl}/api/v1/auth/linking/${sessionId}?token=${encodeURIComponent(linkingToken)}`, {
        method: 'GET'
      })
      return handleResponse<LinkingStatusResponse>(response)
    }
  }
}

function createApiClient(): SyncApiClient {
  const baseUrl = getSyncServerUrl()
  return createApiClientInternal(baseUrl)
}

export function createApiClientWithUrl(serverUrl: string): SyncApiClient {
  return createApiClientInternal(serverUrl)
}

export function getSyncApiClient(): SyncApiClient {
  if (!clientInstance) {
    clientInstance = createApiClient()
  }
  return clientInstance
}

export function isSyncApiError(error: unknown): error is SyncApiError {
  return error instanceof SyncApiError
}
