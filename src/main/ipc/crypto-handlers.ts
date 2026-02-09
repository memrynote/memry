import { ipcMain } from 'electron'
import sodium from 'libsodium-wrappers-sumo'

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
  wrapFileKey,
  unwrapFileKey,
  signPayload,
  verifySignature,
  retrieveKey,
  secureCleanup
} from '../crypto'
import { KEYCHAIN_ENTRIES } from '@shared/contracts/crypto'

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

async function handleEncryptItem(input: EncryptItemInput): Promise<EncryptItemResult> {
  const vaultKey = await retrieveKey(KEYCHAIN_ENTRIES.VAULT_KEY)
  if (!vaultKey) {
    throw new Error('Vault key not found in keychain')
  }

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

    const encData = sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL)
    const dNonce = sodium.to_base64(dataNonce, sodium.base64_variants.ORIGINAL)
    const encKey = sodium.to_base64(wrapped.wrappedKey, sodium.base64_variants.ORIGINAL)
    const kNonce = sodium.to_base64(wrapped.nonce, sodium.base64_variants.ORIGINAL)

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
      signature: sodium.to_base64(signature, sodium.base64_variants.ORIGINAL)
    }
  } finally {
    if (fileKey) secureCleanup(fileKey)
    secureCleanup(vaultKey, signingKey, plaintext)
  }
}

async function handleDecryptItem(input: DecryptItemInput): Promise<DecryptItemResult> {
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

  const publicKey = sodium.from_base64(signerPublicKeyBase64, sodium.base64_variants.ORIGINAL)
  if (publicKey.length !== ED25519_PARAMS.PUBLIC_KEY_LENGTH) {
    return { success: false, error: 'Invalid public key length' }
  }

  const signature = sodium.from_base64(input.signature, sodium.base64_variants.ORIGINAL)
  if (signature.length !== ED25519_PARAMS.SIGNATURE_LENGTH) {
    return { success: false, error: 'Invalid signature length' }
  }

  const valid = verifySignature(signaturePayload, CBOR_FIELD_ORDER.SYNC_ITEM, signature, publicKey)
  if (!valid) {
    return { success: false, error: 'Signature verification failed' }
  }

  const vaultKey = await retrieveKey(KEYCHAIN_ENTRIES.VAULT_KEY)
  if (!vaultKey) {
    return { success: false, error: 'Vault key not found in keychain' }
  }

  try {
    const encryptedKey = sodium.from_base64(input.encryptedKey, sodium.base64_variants.ORIGINAL)
    if (encryptedKey.length === 0) {
      return { success: false, error: 'Invalid encrypted key length' }
    }

    const keyNonce = sodium.from_base64(input.keyNonce, sodium.base64_variants.ORIGINAL)
    if (keyNonce.length !== XCHACHA20_PARAMS.NONCE_LENGTH) {
      return { success: false, error: 'Invalid key nonce length' }
    }

    const encryptedData = sodium.from_base64(input.encryptedData, sodium.base64_variants.ORIGINAL)
    const dataNonce = sodium.from_base64(input.dataNonce, sodium.base64_variants.ORIGINAL)
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

  const publicKey = sodium.from_base64(signerPublicKeyBase64, sodium.base64_variants.ORIGINAL)
  if (publicKey.length !== ED25519_PARAMS.PUBLIC_KEY_LENGTH) {
    return { valid: false }
  }

  const signature = sodium.from_base64(input.signature, sodium.base64_variants.ORIGINAL)
  if (signature.length !== ED25519_PARAMS.SIGNATURE_LENGTH) {
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

  console.log('[IPC] Crypto handlers registered')
}

export function unregisterCryptoHandlers(): void {
  ipcMain.removeHandler(SYNC_CHANNELS.ENCRYPT_ITEM)
  ipcMain.removeHandler(SYNC_CHANNELS.DECRYPT_ITEM)
  ipcMain.removeHandler(SYNC_CHANNELS.VERIFY_SIGNATURE)
  ipcMain.removeHandler(SYNC_CHANNELS.ROTATE_KEYS)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_ROTATION_PROGRESS)

  console.log('[IPC] Crypto handlers unregistered')
}
