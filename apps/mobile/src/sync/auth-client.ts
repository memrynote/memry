import {
  fromBase64,
  signDetached,
  toBase64,
  generateDeviceSigningKeyPair
} from '../crypto/libsodium'
import { createLogger } from '../lib/logger'
import {
  getSessionToken,
  setSessionToken,
  clearSessionToken,
  setDeviceSigningKeypair
} from '../lib/secure-store'
import * as SecureStore from 'expo-secure-store'
import { mobileAppVersion } from '../adapters/runtime'
import { syncBaseUrl } from './server-config'

const log = createLogger('AuthClient')

/**
 * Auth + session against the sync server — the productionized G0 flow
 * (spike/g0-demo.ts, proven on device against production data). Tokens live
 * ONLY in expo-secure-store; no token or key material is ever logged.
 *
 * Secure-store layout used here (data-model §2):
 *   memry.session.<accountId>  → JSON { accessToken, refreshToken, email, deviceId }
 *   memry.device.id            → server-issued device id after registration
 */

export interface StoredSession {
  email: string
  accessToken: string
  refreshToken: string
  deviceId: string
}

const ACCOUNT_KEY = 'default'
const DEVICE_ID_STORE_KEY = 'memry.device.id'

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}

async function request<T>(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(`${syncBaseUrl()}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {})
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string | { code?: string; message?: string }
  }
  if (!response.ok) {
    const detail =
      typeof body.error === 'string'
        ? body.error
        : body.error
          ? `${body.error.code ?? ''} ${body.error.message ?? ''}`.trim()
          : ''
    throw new Error(`${path} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`)
  }
  return body
}

function decodeJwtPayload(token: string): { jti?: string } {
  const segment = token.split('.')[1]
  if (!segment) throw new Error('Malformed JWT')
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return JSON.parse(new TextDecoder().decode(fromBase64(padded)))
}

export async function requestOtp(email: string): Promise<void> {
  await request('/auth/otp/request', { body: { email } })
}

export interface OtpVerifyResult {
  needsSetup: boolean
}

/**
 * Verify the OTP and register this device. On success the session (tokens +
 * device id) is in secure-store. `needsSetup: true` means the account has no
 * vault — US1 requires seeding from desktop first (FR-004 scope).
 */
export async function verifyOtpAndRegisterDevice(
  email: string,
  code: string
): Promise<OtpVerifyResult> {
  const verify = await request<{ setupToken: string; needsSetup: boolean }>('/auth/otp/verify', {
    body: { email, code }
  })
  if (verify.needsSetup) {
    return { needsSetup: true }
  }

  const keyPair = await generateDeviceSigningKeyPair()
  const nonceBytes = new Uint8Array(12)
  crypto.getRandomValues(nonceBytes)
  const nonce = `ios-${Array.from(nonceBytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
  const jti = decodeJwtPayload(verify.setupToken).jti
  if (!jti) throw new Error('Setup token missing jti')
  const challenge = new TextEncoder().encode(`${nonce}:${jti}`)
  const signature = signDetached(challenge, keyPair.secretKey)

  const registered = await request<{ deviceId: string; accessToken: string; refreshToken: string }>(
    '/auth/devices',
    {
      token: verify.setupToken,
      body: {
        name: 'iPhone',
        platform: 'ios',
        appVersion: mobileAppVersion(),
        authPublicKey: toBase64(keyPair.publicKey),
        challengeSignature: toBase64(signature),
        challengeNonce: nonce
      }
    }
  )

  await SecureStore.setItemAsync(DEVICE_ID_STORE_KEY, registered.deviceId, OPTIONS)
  // The auth keypair doubles as the per-vault signing keypair seed store is
  // vault-scoped; the registration keypair is stored under the account scope.
  await setDeviceSigningKeypair('account', {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.secretKey
  })
  await saveSession({
    email,
    accessToken: registered.accessToken,
    refreshToken: registered.refreshToken,
    deviceId: registered.deviceId
  })
  log.info('Device registered')
  return { needsSetup: false }
}

export async function saveSession(session: StoredSession): Promise<void> {
  await setSessionToken(ACCOUNT_KEY, JSON.stringify(session))
}

export async function loadSession(): Promise<StoredSession | null> {
  const raw = await getSessionToken(ACCOUNT_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredSession
  } catch {
    return null
  }
}

export async function clearSession(): Promise<void> {
  await clearSessionToken(ACCOUNT_KEY)
}

/** Rotate tokens. Returns the fresh access token, or null (session gone). */
export async function refreshSession(): Promise<string | null> {
  const session = await loadSession()
  if (!session) return null
  try {
    const tokens = await request<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
      body: { refreshToken: session.refreshToken }
    })
    await saveSession({ ...session, ...tokens })
    return tokens.accessToken
  } catch (err) {
    log.warn('Token refresh failed', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export interface RemoteVault {
  vaultUuid: string
  itemCount: number
  name?: string
}

export async function listVaults(accessToken: string): Promise<RemoteVault[]> {
  const result = await request<{ vaults?: RemoteVault[] }>('/sync/vaults', { token: accessToken })
  return result.vaults ?? []
}

export interface KeyVerifierInfo {
  kdfSalt: string
  keyVerifier: string | null
}

export async function fetchKeyVerifier(accessToken: string): Promise<KeyVerifierInfo> {
  return request<KeyVerifierInfo>('/auth/key-verifier', { token: accessToken })
}

const CURRENT_VAULT_KEY = 'memry.vault.current'

export async function saveCurrentVaultId(vaultId: string): Promise<void> {
  await SecureStore.setItemAsync(CURRENT_VAULT_KEY, vaultId, OPTIONS)
}

export async function loadCurrentVaultId(): Promise<string | null> {
  return SecureStore.getItemAsync(CURRENT_VAULT_KEY, OPTIONS)
}
