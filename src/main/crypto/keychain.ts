/**
 * OS Keychain Storage
 *
 * Provides secure storage for sensitive data using the operating system's
 * native keychain (macOS Keychain, Windows Credential Vault, Linux Secret Service).
 *
 * Stored items:
 * - Master key (encrypted with the OS)
 * - Device ID
 * - User ID
 * - Access/refresh tokens
 *
 * @module main/crypto/keychain
 */

import keytar from 'keytar'
import { KEYCHAIN_KEYS, type KeychainKey } from '@shared/contracts/crypto'

// =============================================================================
// Constants
// =============================================================================

/** Service name for keychain entries (supports multi-instance testing via env var) */
const SERVICE_NAME = process.env.MEMRY_KEYCHAIN_SUFFIX
  ? `memry-${process.env.MEMRY_KEYCHAIN_SUFFIX}`
  : 'memry'

// =============================================================================
// Basic Operations
// =============================================================================

/**
 * Save a value to the OS keychain.
 *
 * @param key - Key name (use KEYCHAIN_KEYS constants)
 * @param value - Value to store
 */
export async function saveToKeychain(key: KeychainKey | string, value: string): Promise<void> {
  await keytar.setPassword(SERVICE_NAME, key, value)
}

/**
 * Get a value from the OS keychain.
 *
 * @param key - Key name (use KEYCHAIN_KEYS constants)
 * @returns Stored value, or null if not found
 */
export async function getFromKeychain(key: KeychainKey | string): Promise<string | null> {
  return keytar.getPassword(SERVICE_NAME, key)
}

/**
 * Delete a value from the OS keychain.
 *
 * @param key - Key name (use KEYCHAIN_KEYS constants)
 * @returns true if deleted, false if not found
 */
export async function deleteFromKeychain(key: KeychainKey | string): Promise<boolean> {
  return keytar.deletePassword(SERVICE_NAME, key)
}

// =============================================================================
// Master Key Operations
// =============================================================================

/**
 * Store the master key in the keychain.
 *
 * The master key is Base64-encoded before storage.
 *
 * @param masterKey - 32-byte master key
 */
export async function saveMasterKey(masterKey: Buffer | Uint8Array): Promise<void> {
  const base64 = Buffer.from(masterKey).toString('base64')
  await saveToKeychain(KEYCHAIN_KEYS.MASTER_KEY, base64)
}

/**
 * Retrieve the master key from the keychain.
 *
 * @returns 32-byte master key, or null if not stored
 */
export async function getMasterKey(): Promise<Buffer | null> {
  const base64 = await getFromKeychain(KEYCHAIN_KEYS.MASTER_KEY)

  if (!base64) {
    return null
  }

  return Buffer.from(base64, 'base64')
}

/**
 * Delete the master key from the keychain.
 *
 * @returns true if deleted
 */
export async function deleteMasterKey(): Promise<boolean> {
  return deleteFromKeychain(KEYCHAIN_KEYS.MASTER_KEY)
}

/**
 * Check if a master key is stored.
 *
 * @returns true if master key exists
 */
export async function hasMasterKey(): Promise<boolean> {
  const key = await getFromKeychain(KEYCHAIN_KEYS.MASTER_KEY)
  return key !== null
}

// =============================================================================
// Device/User ID Operations
// =============================================================================

/**
 * Store the current device ID.
 *
 * @param deviceId - Device UUID
 */
export async function saveDeviceId(deviceId: string): Promise<void> {
  await saveToKeychain(KEYCHAIN_KEYS.DEVICE_ID, deviceId)
}

/**
 * Get the current device ID.
 *
 * @returns Device UUID, or null if not stored
 */
export async function getDeviceId(): Promise<string | null> {
  return getFromKeychain(KEYCHAIN_KEYS.DEVICE_ID)
}

/**
 * Store the current user ID.
 *
 * @param userId - User UUID
 */
export async function saveUserId(userId: string): Promise<void> {
  await saveToKeychain(KEYCHAIN_KEYS.USER_ID, userId)
}

/**
 * Get the current user ID.
 *
 * @returns User UUID, or null if not stored
 */
export async function getUserId(): Promise<string | null> {
  return getFromKeychain(KEYCHAIN_KEYS.USER_ID)
}

// =============================================================================
// Token Operations
// =============================================================================

/**
 * Store authentication tokens.
 *
 * @param accessToken - JWT access token
 * @param refreshToken - Refresh token
 */
export async function saveTokens(accessToken: string, refreshToken: string): Promise<void> {
  await Promise.all([
    saveToKeychain(KEYCHAIN_KEYS.ACCESS_TOKEN, accessToken),
    saveToKeychain(KEYCHAIN_KEYS.REFRESH_TOKEN, refreshToken)
  ])
}

/**
 * Get stored authentication tokens.
 *
 * @returns Object with accessToken and refreshToken, or null if not stored
 */
export async function getTokens(): Promise<{ accessToken: string; refreshToken: string } | null> {
  const [accessToken, refreshToken] = await Promise.all([
    getFromKeychain(KEYCHAIN_KEYS.ACCESS_TOKEN),
    getFromKeychain(KEYCHAIN_KEYS.REFRESH_TOKEN)
  ])

  if (!accessToken || !refreshToken) {
    return null
  }

  return { accessToken, refreshToken }
}

/**
 * Delete authentication tokens.
 */
export async function deleteTokens(): Promise<void> {
  await Promise.all([
    deleteFromKeychain(KEYCHAIN_KEYS.ACCESS_TOKEN),
    deleteFromKeychain(KEYCHAIN_KEYS.REFRESH_TOKEN)
  ])
}

// =============================================================================
// Bulk Operations
// =============================================================================

/**
 * Clear all Memry-related keychain entries.
 *
 * Used during logout or account deletion.
 */
export async function clearAllKeychainEntries(): Promise<void> {
  const allKeys = Object.values(KEYCHAIN_KEYS)

  await Promise.all(allKeys.map((key) => deleteFromKeychain(key)))
}

/**
 * Get all stored credentials for debugging/diagnostics.
 *
 * Returns key names only, not values.
 *
 * @returns Array of stored key names
 */
export async function getStoredKeyNames(): Promise<string[]> {
  const allKeys = Object.values(KEYCHAIN_KEYS)
  const storedKeys: string[] = []

  for (const key of allKeys) {
    const value = await getFromKeychain(key)
    if (value !== null) {
      storedKeys.push(key)
    }
  }

  return storedKeys
}

// =============================================================================
// Sync Session Storage
// =============================================================================

/**
 * Store complete sync session data.
 *
 * @param session - Session data to store
 */
export async function saveSyncSession(session: {
  userId: string
  deviceId: string
  accessToken: string
  refreshToken: string
  masterKey: Buffer | Uint8Array
}): Promise<void> {
  await Promise.all([
    saveUserId(session.userId),
    saveDeviceId(session.deviceId),
    saveTokens(session.accessToken, session.refreshToken),
    saveMasterKey(session.masterKey)
  ])
}

/**
 * Get complete sync session data.
 *
 * @returns Session data, or null if incomplete
 */
export async function getSyncSession(): Promise<{
  userId: string
  deviceId: string
  accessToken: string
  refreshToken: string
  masterKey: Buffer
} | null> {
  const [userId, deviceId, tokens, masterKey] = await Promise.all([
    getUserId(),
    getDeviceId(),
    getTokens(),
    getMasterKey()
  ])

  if (!userId || !deviceId || !tokens || !masterKey) {
    return null
  }

  return {
    userId,
    deviceId,
    ...tokens,
    masterKey
  }
}

/**
 * Check if a complete sync session is stored.
 *
 * @returns true if all session data is available
 */
export async function hasSyncSession(): Promise<boolean> {
  const session = await getSyncSession()
  return session !== null
}

/**
 * Clear the sync session (logout).
 */
export async function clearSyncSession(): Promise<void> {
  await clearAllKeychainEntries()
}

// =============================================================================
// Pending Signup Storage
// =============================================================================

/**
 * Pending signup data structure.
 * Stored temporarily during signup flow until device setup completes.
 */
export interface PendingSignupData {
  email: string
  password: string
  deviceName: string
  recoveryPhrase: string
  userId?: string
  createdAt: number
}

/**
 * Store pending signup data in keychain.
 * This allows the signup flow to survive app restarts.
 *
 * @param data - Pending signup data to store
 */
export async function savePendingSignup(data: PendingSignupData): Promise<void> {
  const json = JSON.stringify(data)
  await saveToKeychain(KEYCHAIN_KEYS.PENDING_SIGNUP, json)
}

/**
 * Get pending signup data from keychain.
 *
 * @returns Pending signup data, or null if not found or expired (30 min)
 */
export async function getPendingSignup(): Promise<PendingSignupData | null> {
  const json = await getFromKeychain(KEYCHAIN_KEYS.PENDING_SIGNUP)

  if (!json) {
    return null
  }

  try {
    const data = JSON.parse(json) as PendingSignupData

    // Check expiry (30 minutes)
    const THIRTY_MINUTES = 30 * 60 * 1000
    if (Date.now() - data.createdAt > THIRTY_MINUTES) {
      await deletePendingSignup()
      return null
    }

    return data
  } catch {
    // Invalid JSON, clear it
    await deletePendingSignup()
    return null
  }
}

/**
 * Delete pending signup data from keychain.
 * Called after successful device setup or on timeout.
 */
export async function deletePendingSignup(): Promise<boolean> {
  return deleteFromKeychain(KEYCHAIN_KEYS.PENDING_SIGNUP)
}
