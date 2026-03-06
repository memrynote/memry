import { BrowserWindow } from 'electron'
import { decodeJwt } from 'jose'

import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import { RefreshTokenResponseSchema } from '@memry/contracts/auth-api'
import { storeKey, retrieveKey } from '../crypto'
import { postToServer, SyncServerError } from './http-client'
import { createLogger } from '../lib/logger'

const log = createLogger('TokenManager')

export const ACCESS_TOKEN_EXPIRY_SECONDS = 900
const REFRESH_MAX_RETRIES = 3
const REFRESH_BACKOFF_BASE_MS = 1000
const FALLBACK_RETRY_THRESHOLD_S = 60
const EXPIRY_SAFETY_MARGIN_SECONDS = 60

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let activeRefreshPromise: Promise<boolean> | null = null
let fallbackRetryScheduled = false
let tokenIssuedAt = 0
let onTokenRefreshedCallback: (() => void) | null = null

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

export const emitSessionExpired = (): void => {
  cancelTokenRefresh()
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send(SYNC_EVENTS.SESSION_EXPIRED, {
      reason: 'token_expired'
    })
  }
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
      if (error instanceof SyncServerError && error.statusCode === 401) break

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
}
