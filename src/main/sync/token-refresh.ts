/**
 * Centralized Token Refresh Manager
 *
 * Provides a single point of control for access token refresh operations.
 * Ensures that only one refresh can happen at a time across all components
 * (SyncEngine, CrdtSyncBridge, IPC handlers), preventing race conditions
 * when multiple components detect an expired token simultaneously.
 *
 * @module sync/token-refresh
 */

import { retrieveAuthTokens, storeAuthTokens } from '../crypto/keychain'
import { getSyncApiClient } from './api-client'

const TOKEN_REFRESH_COOLDOWN_MS = 5_000
const LOG_PREFIX = '[TokenRefresh]'

let lastRefreshAttempt = 0
let refreshPromise: Promise<boolean> | null = null

export async function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise) {
    console.info(`${LOG_PREFIX} Joining existing refresh attempt`)
    return refreshPromise
  }

  const now = Date.now()
  if (now - lastRefreshAttempt < TOKEN_REFRESH_COOLDOWN_MS) {
    console.info(`${LOG_PREFIX} Skipped: within cooldown period`)
    return false
  }

  lastRefreshAttempt = now

  const refreshOperation = (async () => {
    const tokens = await retrieveAuthTokens()
    if (!tokens?.refreshToken) {
      console.warn(`${LOG_PREFIX} No refresh token available`)
      return false
    }

    try {
      const client = getSyncApiClient()
      const response = await client.refreshToken(tokens.refreshToken)
      await storeAuthTokens({
        ...tokens,
        accessToken: response.accessToken,
        refreshToken: response.refreshToken
      })
      console.info(`${LOG_PREFIX} Token refreshed successfully`)
      return true
    } catch (error) {
      console.warn(`${LOG_PREFIX} Token refresh failed`, error)
      return false
    }
  })()

  refreshPromise = refreshOperation
  try {
    return await refreshOperation
  } finally {
    refreshPromise = null
  }
}

export function resetRefreshState(): void {
  lastRefreshAttempt = 0
  refreshPromise = null
}
