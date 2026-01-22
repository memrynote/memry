/**
 * Keychain Storage Module
 *
 * Implements secure storage of key material using the OS keychain via keytar.
 */

import keytar from 'keytar'
import { CryptoError, CryptoErrorCode } from './errors'
import { uint8ArrayToBase64, base64ToUint8Array } from './keys'
import type { StoredKeyMaterial, DeviceSigningKeyPair } from '@shared/contracts/crypto'

/** Service name for keychain storage */
const SERVICE_NAME = 'com.memry.app'

/** Account names for different key types */
const ACCOUNTS = {
  MASTER_KEYS: 'master-keys',
  DEVICE_KEYS: 'device-keys',
  SIGNING_KEYS: 'signing-keys',
  AUTH_TOKENS: 'auth-tokens'
} as const

/** Auth tokens stored in keychain */
export interface StoredAuthTokens {
  accessToken: string
  refreshToken: string
  userId: string
  email: string
  deviceId?: string
}

/** User-level signing keypair (derived from master key) */
export interface StoredSigningKeyPair {
  publicKey: string
  privateKey: string
}

/**
 * Store key material in the OS keychain.
 *
 * @param material - Key material to store
 * @throws CryptoError if storage fails
 */
export async function storeKeyMaterial(material: StoredKeyMaterial): Promise<void> {
  try {
    const json = JSON.stringify(material)
    await keytar.setPassword(SERVICE_NAME, ACCOUNTS.MASTER_KEYS, json)
  } catch (error) {
    throw new CryptoError(
      'Failed to store key material in keychain',
      CryptoErrorCode.KEYCHAIN_ERROR,
      error
    )
  }
}

/**
 * Retrieve key material from the OS keychain.
 *
 * @returns Stored key material or null if not found
 * @throws CryptoError if retrieval fails
 */
export async function retrieveKeyMaterial(): Promise<StoredKeyMaterial | null> {
  try {
    const json = await keytar.getPassword(SERVICE_NAME, ACCOUNTS.MASTER_KEYS)

    if (!json) {
      return null
    }

    return JSON.parse(json) as StoredKeyMaterial
  } catch (error) {
    throw new CryptoError(
      'Failed to retrieve key material from keychain',
      CryptoErrorCode.KEYCHAIN_ERROR,
      error
    )
  }
}

/**
 * Delete key material from the OS keychain.
 *
 * @returns true if deleted, false if not found
 * @throws CryptoError if deletion fails
 */
export async function deleteKeyMaterial(): Promise<boolean> {
  try {
    return await keytar.deletePassword(SERVICE_NAME, ACCOUNTS.MASTER_KEYS)
  } catch (error) {
    throw new CryptoError(
      'Failed to delete key material from keychain',
      CryptoErrorCode.KEYCHAIN_ERROR,
      error
    )
  }
}

/**
 * Store device signing keypair in the OS keychain.
 *
 * @param keyPair - Device signing keypair
 * @throws CryptoError if storage fails
 */
export async function storeDeviceKeyPair(keyPair: DeviceSigningKeyPair): Promise<void> {
  try {
    const storable = {
      publicKey: uint8ArrayToBase64(keyPair.publicKey),
      privateKey: uint8ArrayToBase64(keyPair.privateKey),
      deviceId: keyPair.deviceId
    }
    const json = JSON.stringify(storable)
    await keytar.setPassword(SERVICE_NAME, ACCOUNTS.DEVICE_KEYS, json)
  } catch (error) {
    throw new CryptoError(
      'Failed to store device keypair in keychain',
      CryptoErrorCode.KEYCHAIN_ERROR,
      error
    )
  }
}

/**
 * Retrieve device signing keypair from the OS keychain.
 *
 * @returns Device signing keypair or null if not found
 * @throws CryptoError if retrieval fails
 */
export async function retrieveDeviceKeyPair(): Promise<DeviceSigningKeyPair | null> {
  try {
    const json = await keytar.getPassword(SERVICE_NAME, ACCOUNTS.DEVICE_KEYS)

    if (!json) {
      return null
    }

    const stored = JSON.parse(json) as {
      publicKey: string
      privateKey: string
      deviceId: string
    }

    return {
      publicKey: base64ToUint8Array(stored.publicKey),
      privateKey: base64ToUint8Array(stored.privateKey),
      deviceId: stored.deviceId
    }
  } catch (error) {
    throw new CryptoError(
      'Failed to retrieve device keypair from keychain',
      CryptoErrorCode.KEYCHAIN_ERROR,
      error
    )
  }
}

/**
 * Delete device signing keypair from the OS keychain.
 *
 * @returns true if deleted, false if not found
 * @throws CryptoError if deletion fails
 */
export async function deleteDeviceKeyPair(): Promise<boolean> {
  try {
    return await keytar.deletePassword(SERVICE_NAME, ACCOUNTS.DEVICE_KEYS)
  } catch (error) {
    throw new CryptoError(
      'Failed to delete device keypair from keychain',
      CryptoErrorCode.KEYCHAIN_ERROR,
      error
    )
  }
}

/**
 * Check if key material exists in the keychain.
 *
 * @returns true if key material exists
 */
export async function hasKeyMaterial(): Promise<boolean> {
  const material = await retrieveKeyMaterial()
  return material !== null
}

/**
 * Check if device keypair exists in the keychain.
 *
 * @returns true if device keypair exists
 */
export async function hasDeviceKeyPair(): Promise<boolean> {
  const keyPair = await retrieveDeviceKeyPair()
  return keyPair !== null
}

/**
 * Delete all stored keys from the keychain.
 * Used for logout or account reset.
 *
 * @throws CryptoError if deletion fails
 */
export async function deleteAllKeys(): Promise<void> {
  try {
    await Promise.all([
      keytar.deletePassword(SERVICE_NAME, ACCOUNTS.MASTER_KEYS),
      keytar.deletePassword(SERVICE_NAME, ACCOUNTS.DEVICE_KEYS),
      keytar.deletePassword(SERVICE_NAME, ACCOUNTS.SIGNING_KEYS),
      keytar.deletePassword(SERVICE_NAME, ACCOUNTS.AUTH_TOKENS)
    ])
  } catch (error) {
    throw new CryptoError(
      'Failed to delete all keys from keychain',
      CryptoErrorCode.KEYCHAIN_ERROR,
      error
    )
  }
}

// =============================================================================
// Auth Token Storage (T061)
// =============================================================================

/**
 * Store auth tokens in the OS keychain.
 *
 * @param tokens - Auth tokens to store
 * @throws CryptoError if storage fails
 */
export async function storeAuthTokens(tokens: StoredAuthTokens): Promise<void> {
  try {
    const json = JSON.stringify(tokens)
    await keytar.setPassword(SERVICE_NAME, ACCOUNTS.AUTH_TOKENS, json)
  } catch (error) {
    throw new CryptoError(
      'Failed to store auth tokens in keychain',
      CryptoErrorCode.KEYCHAIN_ERROR,
      error
    )
  }
}

/**
 * Retrieve auth tokens from the OS keychain.
 *
 * @returns Stored auth tokens or null if not found
 * @throws CryptoError if retrieval fails
 */
export async function retrieveAuthTokens(): Promise<StoredAuthTokens | null> {
  try {
    const json = await keytar.getPassword(SERVICE_NAME, ACCOUNTS.AUTH_TOKENS)
    if (!json) {
      return null
    }
    return JSON.parse(json) as StoredAuthTokens
  } catch (error) {
    throw new CryptoError(
      'Failed to retrieve auth tokens from keychain',
      CryptoErrorCode.KEYCHAIN_ERROR,
      error
    )
  }
}

/**
 * Delete auth tokens from the OS keychain.
 *
 * @returns true if deleted, false if not found
 * @throws CryptoError if deletion fails
 */
export async function deleteAuthTokens(): Promise<boolean> {
  try {
    return await keytar.deletePassword(SERVICE_NAME, ACCOUNTS.AUTH_TOKENS)
  } catch (error) {
    throw new CryptoError(
      'Failed to delete auth tokens from keychain',
      CryptoErrorCode.KEYCHAIN_ERROR,
      error
    )
  }
}

// =============================================================================
// User Signing Keypair Storage (T060a)
// =============================================================================

/**
 * Store user-level derived signing keypair in the OS keychain.
 * This keypair is derived from the master key via HKDF.
 *
 * @param keyPair - Signing keypair (Base64 encoded)
 * @throws CryptoError if storage fails
 */
export async function storeSigningKeyPair(keyPair: StoredSigningKeyPair): Promise<void> {
  try {
    const json = JSON.stringify(keyPair)
    await keytar.setPassword(SERVICE_NAME, ACCOUNTS.SIGNING_KEYS, json)
  } catch (error) {
    throw new CryptoError(
      'Failed to store signing keypair in keychain',
      CryptoErrorCode.KEYCHAIN_ERROR,
      error
    )
  }
}

/**
 * Retrieve user-level derived signing keypair from the OS keychain.
 *
 * @returns Stored signing keypair (Base64 encoded) or null if not found
 * @throws CryptoError if retrieval fails
 */
export async function retrieveSigningKeyPair(): Promise<StoredSigningKeyPair | null> {
  try {
    const json = await keytar.getPassword(SERVICE_NAME, ACCOUNTS.SIGNING_KEYS)
    if (!json) {
      return null
    }
    return JSON.parse(json) as StoredSigningKeyPair
  } catch (error) {
    throw new CryptoError(
      'Failed to retrieve signing keypair from keychain',
      CryptoErrorCode.KEYCHAIN_ERROR,
      error
    )
  }
}

/**
 * Delete user-level signing keypair from the OS keychain.
 *
 * @returns true if deleted, false if not found
 * @throws CryptoError if deletion fails
 */
export async function deleteSigningKeyPair(): Promise<boolean> {
  try {
    return await keytar.deletePassword(SERVICE_NAME, ACCOUNTS.SIGNING_KEYS)
  } catch (error) {
    throw new CryptoError(
      'Failed to delete signing keypair from keychain',
      CryptoErrorCode.KEYCHAIN_ERROR,
      error
    )
  }
}
