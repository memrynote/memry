import { ipcMain } from 'electron'
import sodium from 'libsodium-wrappers-sumo'

import { createLogger } from '../lib/logger'
import { createValidatedHandler } from './validate'
import {
  SYNC_CHANNELS,
  EncryptItemSchema,
  DecryptItemSchema,
  VerifySignatureSchema
} from '@shared/contracts/ipc-sync'
import { CBOR_FIELD_ORDER } from '@shared/contracts/cbor-ordering'
import { CRYPTO_VERSION, XCHACHA20_PARAMS, ED25519_PARAMS } from '@shared/contracts/crypto'
import type {
  EncryptItemInput,
  EncryptItemResult,
  DecryptItemInput,
  DecryptItemResult,
  VerifySignatureInput,
  VerifySignatureResult
} from '@shared/contracts/ipc-sync'
import {
  encrypt,
  decrypt,
  generateFileKey,
  getOrDeriveVaultKey,
  wrapFileKey,
  unwrapFileKey,
  signPayload,
  verifySignature,
  retrieveKey,
  secureCleanup
} from '../crypto'
import { KEYCHAIN_ENTRIES } from '@shared/contracts/crypto'

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

const notImplemented = (channel: string) => (): never => {
  throw new Error(`${channel} not yet implemented`)
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

  ipcMain.handle(SYNC_CHANNELS.ROTATE_KEYS, notImplemented('ROTATE_KEYS'))
  ipcMain.handle(SYNC_CHANNELS.GET_ROTATION_PROGRESS, notImplemented('GET_ROTATION_PROGRESS'))

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
