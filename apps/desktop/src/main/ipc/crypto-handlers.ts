import { BrowserWindow, ipcMain } from 'electron'
import sodium from 'libsodium-wrappers-sumo'

import { createLogger } from '../lib/logger'
import { createValidatedHandler } from './validate'
import {
  SYNC_CHANNELS,
  EncryptItemSchema,
  DecryptItemSchema,
  VerifySignatureSchema,
  RotateKeysSchema
} from '@memry/contracts/ipc-sync'
import { SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import {
  CRYPTO_VERSION,
  XCHACHA20_PARAMS,
  ED25519_PARAMS,
  KEYCHAIN_ENTRIES
} from '@memry/contracts/crypto'
import type {
  EncryptItemInput,
  EncryptItemResult,
  DecryptItemInput,
  DecryptItemResult,
  VerifySignatureInput,
  VerifySignatureResult,
  RotateKeysInput,
  RotateKeysResult,
  GetRotationProgressResult
} from '@memry/contracts/ipc-sync'
import type { PullItemResponse, SyncManifest, PushResponse } from '@memry/contracts/sync-api'
import { PullResponseSchema } from '@memry/contracts/sync-api'
import {
  encrypt,
  decrypt,
  generateFileKey,
  getOrDeriveVaultKey,
  deriveKey,
  generateSalt,
  generateRecoveryPhrase,
  deriveMasterKey,
  wrapFileKey,
  unwrapFileKey,
  signPayload,
  verifySignature,
  retrieveKey,
  storeKey,
  secureCleanup
} from '../crypto'
import { KEY_DERIVATION_CONTEXTS } from '@memry/contracts/crypto'
import { eq } from 'drizzle-orm'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { getDatabase } from '../database'
import { getSyncEngine } from '../sync/runtime'
import { getFromServer, postToServer } from '../sync/http-client'
import { getValidAccessToken } from '../sync/token-manager'
import { performKeyRotation, type RotationState } from '../crypto/rotation'

const logger = createLogger('IPC:Crypto')

interface SignatureFields {
  id: string
  type: string
  operation?: string
  encryptedData: string
  dataNonce: string
  encryptedKey: string
  keyNonce: string
  deletedAt?: number
  metadata?: Record<string, unknown>
}

function buildSignaturePayload(fields: SignatureFields): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: fields.id,
    type: fields.type,
    operation: fields.operation,
    cryptoVersion: CRYPTO_VERSION,
    encryptedKey: fields.encryptedKey,
    keyNonce: fields.keyNonce,
    encryptedData: fields.encryptedData,
    dataNonce: fields.dataNonce
  }

  if (fields.deletedAt !== undefined) {
    payload.deletedAt = fields.deletedAt
  }

  if (fields.metadata !== undefined) {
    payload.metadata = fields.metadata
  }

  return payload
}

const BASE64_VARIANT = sodium.base64_variants.ORIGINAL

async function ensureSodiumReady(): Promise<void> {
  await sodium.ready
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    return sodium.from_base64(value, BASE64_VARIANT)
  } catch {
    return null
  }
}

async function handleEncryptItem(input: EncryptItemInput): Promise<EncryptItemResult> {
  await ensureSodiumReady()

  const vaultKey = await getOrDeriveVaultKey()

  const signingKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
  if (!signingKey) {
    throw new Error('Device signing key not found in keychain')
  }

  const plaintext = new TextEncoder().encode(JSON.stringify(input.content))
  let fileKey: Uint8Array | undefined

  try {
    fileKey = generateFileKey()
    const wrapped = wrapFileKey(fileKey, vaultKey)
    const { ciphertext, nonce: dataNonce } = encrypt(plaintext, fileKey)

    const encData = sodium.to_base64(ciphertext, BASE64_VARIANT)
    const dNonce = sodium.to_base64(dataNonce, BASE64_VARIANT)
    const encKey = sodium.to_base64(wrapped.wrappedKey, BASE64_VARIANT)
    const kNonce = sodium.to_base64(wrapped.nonce, BASE64_VARIANT)

    const signaturePayload = buildSignaturePayload({
      id: input.itemId,
      type: input.type,
      operation: input.operation,
      encryptedData: encData,
      dataNonce: dNonce,
      encryptedKey: encKey,
      keyNonce: kNonce,
      deletedAt: input.deletedAt,
      metadata: input.metadata
    })

    const signature = signPayload(signaturePayload, CBOR_FIELD_ORDER.SYNC_ITEM, signingKey)

    return {
      encryptedData: encData,
      dataNonce: dNonce,
      encryptedKey: encKey,
      keyNonce: kNonce,
      signature: sodium.to_base64(signature, BASE64_VARIANT)
    }
  } finally {
    if (fileKey) secureCleanup(fileKey)
    secureCleanup(vaultKey, signingKey, plaintext)
  }
}

async function handleDecryptItem(input: DecryptItemInput): Promise<DecryptItemResult> {
  await ensureSodiumReady()

  const rawDecryptValue = input.metadata?.signerPublicKey
  if (!rawDecryptValue || typeof rawDecryptValue !== 'string') {
    return { success: false, error: 'Signer public key required for verification' }
  }
  const signerPublicKeyBase64 = rawDecryptValue

  const signaturePayload = buildSignaturePayload({
    id: input.itemId,
    type: input.type,
    operation: input.operation,
    encryptedData: input.encryptedData,
    dataNonce: input.dataNonce,
    encryptedKey: input.encryptedKey,
    keyNonce: input.keyNonce,
    deletedAt: input.deletedAt,
    metadata: input.metadata
  })

  const publicKey = decodeBase64(signerPublicKeyBase64)
  if (!publicKey || publicKey.length !== ED25519_PARAMS.PUBLIC_KEY_LENGTH) {
    return { success: false, error: 'Invalid public key length' }
  }

  const signature = decodeBase64(input.signature)
  if (!signature || signature.length !== ED25519_PARAMS.SIGNATURE_LENGTH) {
    return { success: false, error: 'Invalid signature length' }
  }

  const valid = verifySignature(signaturePayload, CBOR_FIELD_ORDER.SYNC_ITEM, signature, publicKey)
  if (!valid) {
    return { success: false, error: 'Signature verification failed' }
  }

  let vaultKey: Uint8Array
  try {
    vaultKey = await getOrDeriveVaultKey()
  } catch {
    return { success: false, error: 'Failed to derive vault key — master key missing' }
  }

  try {
    const encryptedKey = sodium.from_base64(input.encryptedKey, BASE64_VARIANT)
    if (encryptedKey.length === 0) {
      return { success: false, error: 'Invalid encrypted key length' }
    }

    const keyNonce = sodium.from_base64(input.keyNonce, BASE64_VARIANT)
    if (keyNonce.length !== XCHACHA20_PARAMS.NONCE_LENGTH) {
      return { success: false, error: 'Invalid key nonce length' }
    }

    const encryptedData = sodium.from_base64(input.encryptedData, BASE64_VARIANT)
    const dataNonce = sodium.from_base64(input.dataNonce, BASE64_VARIANT)
    if (dataNonce.length !== XCHACHA20_PARAMS.NONCE_LENGTH) {
      return { success: false, error: 'Invalid data nonce length' }
    }

    const fileKey = unwrapFileKey(encryptedKey, keyNonce, vaultKey)

    try {
      const plaintext = decrypt(encryptedData, dataNonce, fileKey)

      try {
        const content = JSON.parse(new TextDecoder().decode(plaintext))
        return { success: true, content }
      } finally {
        secureCleanup(plaintext)
      }
    } finally {
      secureCleanup(fileKey)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Decryption failed'
    return { success: false, error: message }
  } finally {
    secureCleanup(vaultKey)
  }
}

async function handleVerifySignature(input: VerifySignatureInput): Promise<VerifySignatureResult> {
  await ensureSodiumReady()

  const signaturePayload = buildSignaturePayload({
    id: input.itemId,
    type: input.type,
    operation: input.operation,
    encryptedData: input.encryptedData,
    dataNonce: input.dataNonce,
    encryptedKey: input.encryptedKey,
    keyNonce: input.keyNonce,
    deletedAt: input.deletedAt,
    metadata: input.metadata
  })

  const rawValue = input.metadata?.signerPublicKey
  if (!rawValue || typeof rawValue !== 'string') {
    return { valid: false }
  }
  const signerPublicKeyBase64 = rawValue

  const publicKey = decodeBase64(signerPublicKeyBase64)
  if (!publicKey || publicKey.length !== ED25519_PARAMS.PUBLIC_KEY_LENGTH) {
    return { valid: false }
  }

  const signature = decodeBase64(input.signature)
  if (!signature || signature.length !== ED25519_PARAMS.SIGNATURE_LENGTH) {
    return { valid: false }
  }

  const valid = verifySignature(signaturePayload, CBOR_FIELD_ORDER.SYNC_ITEM, signature, publicKey)
  return { valid }
}

let currentRotationState: RotationState | null = null
let rotationLock = false

function emitToAllWindows(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, data)
  }
}

async function handleRotateKeys(input: RotateKeysInput): Promise<RotateKeysResult> {
  if (!input.confirm) {
    return { success: false, error: 'Key rotation not confirmed' }
  }

  if (rotationLock) {
    return { success: false, error: 'Key rotation already in progress' }
  }
  rotationLock = true

  let seed: Uint8Array | undefined
  let newMasterKey: Uint8Array | undefined
  let newVaultKey: Uint8Array | undefined
  let salt: Uint8Array | undefined

  try {
    await ensureSodiumReady()

    const generated = await generateRecoveryPhrase()
    seed = generated.seed
    const phrase = generated.phrase
    salt = generateSalt()

    const material = await deriveMasterKey(seed, salt)
    newMasterKey = material.masterKey
    newVaultKey = await deriveKey(newMasterKey, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)

    const result = await performKeyRotation(
      {
        getAccessToken: getValidAccessToken,
        getVaultKey: async () => getOrDeriveVaultKey(),
        getSigningKeys: async () => {
          const sk = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
          if (!sk) return null
          const db = getDatabase()
          const device = db
            .select({ id: syncDevices.id })
            .from(syncDevices)
            .where(eq(syncDevices.isCurrentDevice, true))
            .get()
          if (!device) {
            secureCleanup(sk)
            return null
          }
          const pk = sodium.crypto_sign_ed25519_sk_to_pk(sk)
          return { secretKey: sk, publicKey: pk, deviceId: device.id }
        },
        fetchManifest: (token) => getFromServer<SyncManifest>('/sync/manifest', token),
        pullItems: async (token, itemIds) => {
          const raw = await postToServer<{ items: PullItemResponse[] }>(
            '/sync/pull',
            { itemIds },
            token
          )
          const parsed = PullResponseSchema.safeParse(raw)
          if (!parsed.success) {
            throw new Error(`Invalid pull response: ${parsed.error.message}`)
          }
          return parsed.data.items
        },
        pushItems: async (token, items) => {
          return postToServer<PushResponse>('/sync/push', { items }, token)
        },
        fetchCrdtSnapshots: async (token, noteIds) => {
          const results: Array<{ noteId: string; snapshot: Uint8Array; sequenceNum: number }> = []
          for (const noteId of noteIds) {
            const resp = await getFromServer<{
              snapshot: string | null
              sequenceNum: number
            }>(`/sync/crdt/snapshot/${encodeURIComponent(noteId)}`, token)
            if (resp.snapshot) {
              results.push({
                noteId,
                snapshot: Buffer.from(resp.snapshot, 'base64'),
                sequenceNum: resp.sequenceNum
              })
            }
          }
          return results
        },
        pushCrdtSnapshot: async (token, noteId, snapshot) => {
          const b64 = Buffer.from(snapshot).toString('base64')
          await postToServer('/sync/crdt/snapshot', { noteId, snapshot: b64 }, token)
        },
        updateServerKeys: async (token, kdfSalt, keyVerifier) => {
          await postToServer('/auth/setup', { kdfSalt, keyVerifier }, token)
        },
        pauseSync: () => {
          const engine = getSyncEngine()
          engine?.pause()
        },
        resumeSync: () => {
          const engine = getSyncEngine()
          engine?.resume()
        },
        storeNewMasterKey: async (mk) => {
          await storeKey(KEYCHAIN_ENTRIES.MASTER_KEY, mk)
        },
        onProgress: (rotationState) => {
          currentRotationState = rotationState
          emitToAllWindows(SYNC_EVENTS.KEY_ROTATION_PROGRESS, {
            phase: rotationState.phase,
            totalItems: rotationState.totalItems,
            processedItems: rotationState.processedItems,
            error: rotationState.error
          })
        }
      },
      newVaultKey,
      material.kdfSalt,
      material.keyVerifier,
      newMasterKey
    )

    if (result.success) {
      return { success: true, newRecoveryPhrase: phrase }
    }
    return { success: false, error: result.error }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Key rotation failed'
    logger.error('handleRotateKeys failed', err)
    return { success: false, error: message }
  } finally {
    rotationLock = false
    if (seed) secureCleanup(seed)
    if (salt) secureCleanup(salt)
    if (newVaultKey) secureCleanup(newVaultKey)
    if (newMasterKey) secureCleanup(newMasterKey)
  }
}

function handleGetRotationProgress(): GetRotationProgressResult {
  if (!currentRotationState) {
    return { inProgress: false }
  }
  return {
    inProgress: currentRotationState.inProgress,
    phase: currentRotationState.phase,
    totalItems: currentRotationState.totalItems,
    processedItems: currentRotationState.processedItems
  }
}

export function registerCryptoHandlers(): void {
  ipcMain.handle(
    SYNC_CHANNELS.ENCRYPT_ITEM,
    createValidatedHandler(EncryptItemSchema, handleEncryptItem)
  )

  ipcMain.handle(
    SYNC_CHANNELS.DECRYPT_ITEM,
    createValidatedHandler(DecryptItemSchema, handleDecryptItem)
  )

  ipcMain.handle(
    SYNC_CHANNELS.VERIFY_SIGNATURE,
    createValidatedHandler(VerifySignatureSchema, handleVerifySignature)
  )

  ipcMain.handle(
    SYNC_CHANNELS.ROTATE_KEYS,
    createValidatedHandler(RotateKeysSchema, handleRotateKeys)
  )

  ipcMain.handle(SYNC_CHANNELS.GET_ROTATION_PROGRESS, handleGetRotationProgress)

  logger.info('Crypto handlers registered')
}

export function unregisterCryptoHandlers(): void {
  ipcMain.removeHandler(SYNC_CHANNELS.ENCRYPT_ITEM)
  ipcMain.removeHandler(SYNC_CHANNELS.DECRYPT_ITEM)
  ipcMain.removeHandler(SYNC_CHANNELS.VERIFY_SIGNATURE)
  ipcMain.removeHandler(SYNC_CHANNELS.ROTATE_KEYS)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_ROTATION_PROGRESS)

  logger.info('Crypto handlers unregistered')
}
