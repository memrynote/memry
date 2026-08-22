/**
 * G0 gate demo (spec 001-mobile-app T014 / G0-e): sign in to staging, pull one
 * desktop-created encrypted note, decrypt through the T012 crypto module, and
 * print the plaintext markdown SHA-256 — it must equal desktop's
 * (`shasum -a 256` over the same note's raw markdown bytes).
 *
 * Spike-quality by design: tokens and key material live in memory only for the
 * duration of the demo (secure-store handling is Phase 2, T035). Never point
 * this at production.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { mnemonicToSeed, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { inflate } from 'pako'
import sodium from 'react-native-libsodium'

import {
  decrypt,
  deriveKey,
  deriveMasterKey,
  fromBase64,
  generateDeviceSigningKeyPair,
  toHex
} from '@/crypto/libsodium'

export const DEMO_SERVERS = {
  staging: 'https://sync-staging.memrynote.com',
  // Production carries real user data. The spike's only account write is the
  // device-registration row (revocable from desktop settings); it never pushes
  // sync items — the pull path is read-only. Use your own account only.
  production: 'https://sync.memrynote.com'
} as const

export type DemoServer = keyof typeof DEMO_SERVERS

// Default production — Kaan's call for the G0 run (staging is half-seeded);
// a Metro reload resets module state, so a staging default kept silently
// pointing retries at the wrong account.
let activeServer: DemoServer = 'production'

export const setDemoServer = (server: DemoServer): void => {
  activeServer = server
}

export const getDemoServer = (): DemoServer => activeServer

export interface DemoSession {
  setupToken?: string
  accessToken?: string
  deviceId?: string
  vaultKey?: Uint8Array
  vaultId?: string
}

const decodeJwtPayload = (token: string): { jti?: string } => {
  const segment = token.split('.')[1]
  if (!segment) throw new Error('Malformed JWT')
  const bytes = sodium.from_base64(segment, sodium.base64_variants.URLSAFE_NO_PADDING)
  return JSON.parse(new TextDecoder().decode(bytes))
}

const request = async <T>(
  path: string,
  init: RequestInit & { token?: string; vaultId?: string } = {}
): Promise<T> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    ...(init.vaultId ? { 'X-Memry-Vault-Id': init.vaultId } : {}),
    // Spike declares only the type it pulls; full negotiation is Phase 2+.
    'X-Memry-Sync-Types': 'note'
  }
  const response = await fetch(`${DEMO_SERVERS[activeServer]}${path}`, { ...init, headers })
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
    const retryAfter = response.headers.get('Retry-After')
    throw new Error(
      `${path} → HTTP ${response.status}${detail ? `: ${detail}` : ''}${retryAfter ? ` (retry after ${retryAfter}s)` : ''}`
    )
  }
  return body
}

export const requestOtp = async (email: string): Promise<void> => {
  await request('/auth/otp/request', { method: 'POST', body: JSON.stringify({ email }) })
}

export const verifyOtpAndRegister = async (
  email: string,
  code: string,
  session: DemoSession
): Promise<void> => {
  const verify = await request<{ setupToken: string; needsSetup: boolean }>('/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ email, code })
  })
  if (verify.needsSetup) {
    throw new Error(
      'Account has no vault yet — seed it from desktop first (quickstart §Prerequisites)'
    )
  }
  session.setupToken = verify.setupToken

  const keyPair = await generateDeviceSigningKeyPair()
  const nonce = `spike-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  const jti = decodeJwtPayload(verify.setupToken).jti
  if (!jti) throw new Error('Setup token missing jti')
  const challenge = new TextEncoder().encode(`${nonce}:${jti}`)
  const signature = sodium.crypto_sign_detached(challenge, keyPair.secretKey)

  const registered = await request<{ deviceId: string; accessToken: string; refreshToken: string }>(
    '/auth/devices',
    {
      method: 'POST',
      token: verify.setupToken,
      body: JSON.stringify({
        name: 'G0 spike device',
        platform: 'ios',
        appVersion: '0.1.0-spike',
        authPublicKey: sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL),
        challengeSignature: sodium.to_base64(signature, sodium.base64_variants.ORIGINAL),
        challengeNonce: nonce
      })
    }
  )
  session.accessToken = registered.accessToken
  session.deviceId = registered.deviceId
}

// There is no vault "password" in the product: the master key derives from the
// 24-word BIP39 recovery phrase — seed = mnemonicToSeed(phrase) (PBKDF2-SHA512,
// empty passphrase), then Argon2id(seed, kdfSalt). Mirrors desktop
// crypto/recovery.ts recoverMasterKeyFromPhrase.
export const unlockVault = async (recoveryPhrase: string, session: DemoSession): Promise<void> => {
  if (!session.accessToken) throw new Error('Sign in first')

  const phrase = recoveryPhrase.trim().toLowerCase().split(/\s+/).join(' ')
  if (!validateMnemonic(phrase, wordlist)) {
    throw new Error('Not a valid 24-word recovery phrase (check spelling/word count)')
  }

  const info = await request<{ kdfSalt: string; keyVerifier: string | null }>(
    '/auth/key-verifier',
    {
      token: session.accessToken
    }
  )
  if (!info.kdfSalt) throw new Error('Account has no kdfSalt — vault never set up')

  const seed = await mnemonicToSeed(phrase)
  // Argon2id 64 MiB / ops 3 on-device — this call IS the R1 memory check.
  const material = await deriveMasterKey(seed, fromBase64(info.kdfSalt))
  if (info.keyVerifier && material.keyVerifier !== info.keyVerifier) {
    throw new Error('Wrong recovery phrase (key verifier mismatch)')
  }
  session.vaultKey = await deriveKey(material.masterKey, 'memry-vault-key-v1', 32)
}

export interface PulledNote {
  itemId: string
  title: string
  markdownSha256: string
  markdownLength: number
}

export const pullAndDecryptNote = async (session: DemoSession): Promise<PulledNote> => {
  const vaultKey = session.vaultKey
  if (!vaultKey || !session.accessToken) throw new Error('Unlock the vault first')

  const vaults = await request<{ vaults?: { vaultUuid: string; itemCount: number }[] }>(
    '/sync/vaults',
    { token: session.accessToken }
  )
  const vault = [...(vaults.vaults ?? [])].sort((a, b) => b.itemCount - a.itemCount)[0]
  if (!vault?.vaultUuid) {
    throw new Error(`No vault registered on this ${getDemoServer()} account`)
  }
  const vaultId = vault.vaultUuid
  session.vaultId = vaultId

  const changes = await request<{ items: { id: string; type: string }[] }>(
    '/sync/changes?cursor=0&limit=100',
    { token: session.accessToken, vaultId }
  )
  const noteRef = changes.items.find((item) => item.type === 'note')
  if (!noteRef) throw new Error('No note found in the first 100 changes — seed one from desktop')

  const pulled = await request<{
    items: {
      id: string
      blob: { encryptedKey: string; keyNonce: string; encryptedData: string; dataNonce: string }
    }[]
  }>('/sync/pull', {
    method: 'POST',
    token: session.accessToken,
    vaultId,
    body: JSON.stringify({ itemIds: [noteRef.id] })
  })
  const item = pulled.items[0]
  if (!item) throw new Error('Pull returned no items')

  const fileKey = decrypt(
    fromBase64(item.blob.encryptedKey),
    fromBase64(item.blob.keyNonce),
    vaultKey
  )
  const payloadBytes = decrypt(
    fromBase64(item.blob.encryptedData),
    fromBase64(item.blob.dataNonce),
    fileKey
  )
  // Desktop compresses before encrypting (sync/compress.ts): first plaintext
  // byte is a flag — 0x00 raw, 0x01 zlib deflate.
  const flag = payloadBytes[0]
  const body = payloadBytes.subarray(1)
  const jsonBytes = flag === 0x01 ? inflate(body) : body
  const payload = JSON.parse(new TextDecoder().decode(jsonBytes)) as {
    title?: string
    content?: string | null
  }
  if (typeof payload.content !== 'string') {
    throw new Error(`Note ${item.id} has no inline content in its payload`)
  }

  return {
    itemId: item.id,
    title: payload.title ?? '(untitled)',
    markdownSha256: toHex(sha256(new TextEncoder().encode(payload.content))),
    markdownLength: payload.content.length
  }
}
