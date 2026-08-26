/**
 * Device secure store (data-model.md §2).
 *
 * Every entry is `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and non-synchronizable —
 * nothing here reaches iCloud keychain sync, the DB, logs, telemetry, or
 * backups (FR-003). Values are never logged; callers must not log them either.
 *
 * Key map (exactly data-model §2):
 *   memry.session.<accountId>         auth session/refresh token
 *   memry.vault.<vaultId>.key         unwrapped vault key — absence ⇒ locked
 *   memry.device.<vaultId>.signing    device Ed25519 keypair
 *   memry.device.id                   stable device identifier
 */
import * as SecureStore from 'expo-secure-store'
import { base64ToBytes, bytesToBase64 } from './base64'

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}

// expo-secure-store keys must match [A-Za-z0-9._-]+; account and vault ids are
// UUID-shaped but sanitize defensively so a malformed id cannot throw here.
function safeIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}

const sessionKey = (accountId: string) => `memry.session.${safeIdSegment(accountId)}`
const vaultKeyKey = (vaultId: string) => `memry.vault.${safeIdSegment(vaultId)}.key`
const deviceSigningKey = (vaultId: string) => `memry.device.${safeIdSegment(vaultId)}.signing`
const DEVICE_ID_KEY = 'memry.device.id'

// Base64 lives in `lib/base64` now — the editor bridge and the WebView asset
// need the same helpers, and a 1 MB payload needs the table-based decoder.
export { base64ToBytes, bytesToBase64 }

// -- session token ----------------------------------------------------------

export async function getSessionToken(accountId: string): Promise<string | null> {
  return SecureStore.getItemAsync(sessionKey(accountId), OPTIONS)
}

export async function setSessionToken(accountId: string, token: string): Promise<void> {
  await SecureStore.setItemAsync(sessionKey(accountId), token, OPTIONS)
}

export async function clearSessionToken(accountId: string): Promise<void> {
  await SecureStore.deleteItemAsync(sessionKey(accountId), OPTIONS)
}

// -- vault key (unwrapped; absence ⇒ locked state) --------------------------

export async function getVaultKey(vaultId: string): Promise<Uint8Array | null> {
  const stored = await SecureStore.getItemAsync(vaultKeyKey(vaultId), OPTIONS)
  return stored === null ? null : base64ToBytes(stored)
}

export async function setVaultKey(vaultId: string, key: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(vaultKeyKey(vaultId), bytesToBase64(key), OPTIONS)
}

export async function clearVaultKey(vaultId: string): Promise<void> {
  await SecureStore.deleteItemAsync(vaultKeyKey(vaultId), OPTIONS)
}

// -- device Ed25519 signing keypair (generated on device) -------------------

export interface StoredSigningKeypair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export async function getDeviceSigningKeypair(
  vaultId: string
): Promise<StoredSigningKeypair | null> {
  const stored = await SecureStore.getItemAsync(deviceSigningKey(vaultId), OPTIONS)
  if (stored === null) return null
  const parsed = JSON.parse(stored) as { publicKey: string; privateKey: string }
  return {
    publicKey: base64ToBytes(parsed.publicKey),
    privateKey: base64ToBytes(parsed.privateKey)
  }
}

export async function setDeviceSigningKeypair(
  vaultId: string,
  keypair: StoredSigningKeypair
): Promise<void> {
  const encoded = JSON.stringify({
    publicKey: bytesToBase64(keypair.publicKey),
    privateKey: bytesToBase64(keypair.privateKey)
  })
  await SecureStore.setItemAsync(deviceSigningKey(vaultId), encoded, OPTIONS)
}

export async function clearDeviceSigningKeypair(vaultId: string): Promise<void> {
  await SecureStore.deleteItemAsync(deviceSigningKey(vaultId), OPTIONS)
}

// -- stable device identifier -----------------------------------------------

export async function clearDeviceId(): Promise<void> {
  await SecureStore.deleteItemAsync(DEVICE_ID_KEY, OPTIONS)
}

export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY, OPTIONS)
  if (existing !== null) return existing
  // crypto-polyfill (root layout's first import) guarantees getRandomValues.
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  await SecureStore.setItemAsync(DEVICE_ID_KEY, id, OPTIONS)
  return id
}
