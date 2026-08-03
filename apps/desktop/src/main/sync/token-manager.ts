import { decodeJwt } from 'jose'

import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import type { SessionExpiredReason } from '@memry/contracts/ipc-events'
import { SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import { RefreshTokenResponseSchema } from '@memry/contracts/auth-api'
import { storeKey, retrieveKey } from '../crypto'
import { postToServer, SyncServerError } from './http-client'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'

const log = createLogger('TokenManager')

export const ACCESS_TOKEN_EXPIRY_SECONDS = 900
const REFRESH_MAX_RETRIES = 3
const REFRESH_BACKOFF_BASE_MS = 1000
const FALLBACK_RETRY_THRESHOLD_S = 60
const EXPIRY_SAFETY_MARGIN_SECONDS = 60

/**
 * A 401 on /auth/refresh means the refresh token itself is dead, so retrying
 * cannot succeed — but `getValidAccessToken()` has ~15 demand-driven callers
 * (sync passes, WS reconnects, CRDT pushes, attachments, calendar, billing),
 * and every one of them re-entered the refresh path once the access token was
 * permanently expired. That produced a server-side storm (prod: 58 requests in
 * 47 minutes from one install) while the app sat in a zombie signed-in state.
 *
 * So a rejection latches: the window blocks all refresh traffic without
 * touching the network, and after this many rejections the latch is permanent
 * and the user is prompted to sign in again. The spacing exists only so a
 * transient server-side 401 has room to recover before we declare the session
 * dead — a truly dead token costs 3 requests instead of 58.
 */
const REFRESH_REJECT_TERMINAL_ATTEMPTS = 3
const REFRESH_REJECT_BACKOFF_MS = [60_000, 300_000]

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let activeRefreshPromise: Promise<boolean> | null = null
let fallbackRetryScheduled = false
let tokenIssuedAt = 0
let onTokenRefreshedCallback: (() => void) | null = null
let refreshRejections = 0
let refreshBlockedUntil = 0

export function setOnTokenRefreshed(cb: () => void): void {
  onTokenRefreshedCallback = cb
}

export const storeToken = async (
  entry: (typeof KEYCHAIN_ENTRIES)[keyof typeof KEYCHAIN_ENTRIES],
  token: string
): Promise<void> => {
  const encoded = new TextEncoder().encode(token)
  await storeKey(entry, encoded)
}

export const retrieveToken = async (
  entry: (typeof KEYCHAIN_ENTRIES)[keyof typeof KEYCHAIN_ENTRIES]
): Promise<string | null> => {
  const encoded = await retrieveKey(entry)
  if (!encoded) return null
  return new TextDecoder().decode(encoded)
}

export const extractJtiFromToken = (token: string): string => {
  const payload = decodeJwt(token)
  if (!payload.jti) throw new Error('Token missing jti claim')
  return payload.jti
}

export function isTokenExpired(token: string): boolean {
  try {
    const payload = decodeJwt(token)
    if (typeof payload.exp !== 'number') return true
    const nowSeconds = Math.floor(Date.now() / 1000)
    return payload.exp <= nowSeconds + EXPIRY_SAFETY_MARGIN_SECONDS
  } catch {
    return true
  }
}

export const scheduleTokenRefresh = (expiresInSeconds: number): void => {
  cancelTokenRefresh()
  fallbackRetryScheduled = false
  // Every path that establishes a usable session lands here (sign-in, device
  // registration, successful refresh), so this is where a latched-dead session
  // is released — without it, signing in again would leave sync permanently
  // blocked by the previous session's latch.
  clearRefreshRejections()
  tokenIssuedAt = Date.now()
  const jitter = 0.5 + Math.random() * 0.2
  const refreshAtMs = Math.floor(expiresInSeconds * jitter) * 1000
  refreshTimer = setTimeout(() => {
    void refreshAccessToken()
  }, refreshAtMs)
}

export const cancelTokenRefresh = (): void => {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

export const emitSessionExpired = (reason: SessionExpiredReason = 'token_expired'): void => {
  cancelTokenRefresh()
  broadcastToAllWindows(SYNC_EVENTS.SESSION_EXPIRED, { reason })
}

const clearRefreshRejections = (): void => {
  refreshRejections = 0
  refreshBlockedUntil = 0
}

const isRefreshBlocked = (): boolean => Date.now() < refreshBlockedUntil

/**
 * The server rejected the refresh token. Never retried inline — the caller
 * returns immediately and the latch keeps every other caller off the network
 * until the backoff window elapses (or forever, once terminal).
 */
const handleRefreshRejected = (error: SyncServerError): void => {
  refreshRejections += 1
  cancelTokenRefresh()

  if (refreshRejections >= REFRESH_REJECT_TERMINAL_ATTEMPTS) {
    refreshBlockedUntil = Number.POSITIVE_INFINITY
    log.error('Refresh token rejected — session is dead, re-authentication required', {
      attempts: refreshRejections,
      statusCode: error.statusCode,
      serverError: error.serverError
    })
    emitSessionExpired('refresh_rejected')
    return
  }

  const backoffMs =
    REFRESH_REJECT_BACKOFF_MS[refreshRejections - 1] ?? REFRESH_REJECT_BACKOFF_MS.at(-1)!
  refreshBlockedUntil = Date.now() + backoffMs
  log.warn('Refresh token rejected by server', {
    attempt: refreshRejections,
    of: REFRESH_REJECT_TERMINAL_ATTEMPTS,
    retryInSeconds: Math.floor(backoffMs / 1000),
    statusCode: error.statusCode,
    serverError: error.serverError
  })
  // Keep the pre-existing advisory signal on the way to terminal, so the user
  // isn't left with a silently stalled sync for the whole backoff span.
  emitSessionExpired('token_expired')
}

const doRefreshAccessToken = async (): Promise<boolean> => {
  for (let attempt = 0; attempt < REFRESH_MAX_RETRIES; attempt++) {
    const currentRefreshToken = await retrieveToken(KEYCHAIN_ENTRIES.REFRESH_TOKEN)
    if (!currentRefreshToken) {
      emitSessionExpired()
      return false
    }

    try {
      const raw = await postToServer<unknown>('/auth/refresh', {
        refreshToken: currentRefreshToken
      })
      const response = RefreshTokenResponseSchema.parse(raw)

      await storeToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN, response.accessToken)
      await storeToken(KEYCHAIN_ENTRIES.REFRESH_TOKEN, response.refreshToken)
      scheduleTokenRefresh(response.expiresIn)
      onTokenRefreshedCallback?.()
      return true
    } catch (error: unknown) {
      if (error instanceof SyncServerError && error.statusCode === 401) {
        handleRefreshRejected(error)
        return false
      }

      log.warn('Token refresh attempt failed', {
        attempt: attempt + 1,
        of: REFRESH_MAX_RETRIES,
        error: error instanceof Error ? error.message : String(error)
      })

      if (attempt < REFRESH_MAX_RETRIES - 1) {
        const backoff = REFRESH_BACKOFF_BASE_MS * Math.pow(2, attempt)
        await new Promise((resolve) => setTimeout(resolve, backoff))
      }
    }
  }

  if (!fallbackRetryScheduled && tokenIssuedAt > 0) {
    const elapsedS = (Date.now() - tokenIssuedAt) / 1000
    const remainingS = ACCESS_TOKEN_EXPIRY_SECONDS - elapsedS
    if (remainingS > FALLBACK_RETRY_THRESHOLD_S) {
      fallbackRetryScheduled = true
      const retryAtMs = Math.floor(remainingS * 0.9) * 1000
      refreshTimer = setTimeout(() => {
        void refreshAccessToken()
      }, retryAtMs)
      log.warn(`Scheduling fallback retry in ${Math.floor(retryAtMs / 1000)}s`)
      return false
    }
  }

  emitSessionExpired()
  return false
}

export const refreshAccessToken = async (): Promise<boolean> => {
  if (isRefreshBlocked()) {
    log.debug('Refresh suppressed: refresh token was rejected', {
      rejections: refreshRejections,
      terminal: refreshBlockedUntil === Number.POSITIVE_INFINITY
    })
    return false
  }
  if (activeRefreshPromise) return activeRefreshPromise

  activeRefreshPromise = doRefreshAccessToken()
  try {
    return await activeRefreshPromise
  } finally {
    activeRefreshPromise = null
  }
}

export async function getValidAccessToken(): Promise<string | null> {
  const token = await retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN)
  if (!token) return null

  if (!isTokenExpired(token)) return token

  log.debug('Access token expired or near-expiry, attempting refresh')
  const refreshed = await refreshAccessToken()
  if (!refreshed) return null

  return retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN)
}

export function resetTokenManagerState(): void {
  cancelTokenRefresh()
  activeRefreshPromise = null
  fallbackRetryScheduled = false
  tokenIssuedAt = 0
  onTokenRefreshedCallback = null
  clearRefreshRejections()
}
