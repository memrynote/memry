import { ipcMain } from 'electron'
import sodium from 'libsodium-wrappers-sumo'

import { createValidatedHandler } from './validate'
import { SYNC_CHANNELS, EncryptItemSchema, DecryptItemSchema, VerifySignatureSchema } from '@shared/contracts/ipc-sync'
import { CBOR_FIELD_ORDER } from '@shared/contracts/cbor-ordering'
import type { EncryptItemInput, EncryptItemResult, DecryptItemInput, DecryptItemResult, VerifySignatureInput, VerifySignatureResult } from '@shared/contracts/ipc-sync'
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

  try {
    const fileKey = generateFileKey()
    const wrapped = wrapFileKey(fileKey, vaultKey)
    const { ciphertext, nonce: dataNonce } = encrypt(plaintext, fileKey)

    const encData = sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL)
    const dNonce = sodium.to_base64(dataNonce, sodium.base64_variants.ORIGINAL)
    const encKey = sodium.to_base64(wrapped.wrappedKey, sodium.base64_variants.ORIGINAL)
    const kNonce = sodium.to_base64(wrapped.nonce, sodium.base64_variants.ORIGINAL)

    const signaturePayload: Record<string, unknown> = {
      id: input.itemId,
      type: input.type,
      operation: input.operation,
      encryptedData: encData,
      dataNonce: dNonce,
      encryptedKey: encKey,
      keyNonce: kNonce
    }

    const signature = signPayload(signaturePayload, CBOR_FIELD_ORDER.SYNC_ITEM, signingKey)

    secureCleanup(fileKey)

    return {
      encryptedData: encData,
      dataNonce: dNonce,
      encryptedKey: encKey,
      keyNonce: kNonce,
      signature: sodium.to_base64(signature, sodium.base64_variants.ORIGINAL)
    }
  } finally {
    secureCleanup(vaultKey, signingKey)
  }
}

async function handleDecryptItem(input: DecryptItemInput): Promise<DecryptItemResult> {
  const vaultKey = await retrieveKey(KEYCHAIN_ENTRIES.VAULT_KEY)
  if (!vaultKey) {
    return { success: false, error: 'Vault key not found in keychain' }
  }

  try {
    const encryptedKey = sodium.from_base64(input.encryptedKey, sodium.base64_variants.ORIGINAL)
    const keyNonce = sodium.from_base64(input.keyNonce, sodium.base64_variants.ORIGINAL)
    const encryptedData = sodium.from_base64(input.encryptedData, sodium.base64_variants.ORIGINAL)
    const dataNonce = sodium.from_base64(input.dataNonce, sodium.base64_variants.ORIGINAL)

    const fileKey = unwrapFileKey(encryptedKey, keyNonce, vaultKey)
    const plaintext = decrypt(encryptedData, dataNonce, fileKey)

    secureCleanup(fileKey)

    const content = JSON.parse(new TextDecoder().decode(plaintext))
    return { success: true, content }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Decryption failed'
    return { success: false, error: message }
  } finally {
    secureCleanup(vaultKey)
  }
}

async function handleVerifySignature(input: VerifySignatureInput): Promise<VerifySignatureResult> {
  const signaturePayload: Record<string, unknown> = {
    id: input.itemId,
    type: input.type,
    operation: input.operation,
    encryptedData: input.encryptedData,
    dataNonce: input.dataNonce,
    encryptedKey: input.encryptedKey,
    keyNonce: input.keyNonce
  }

  const signerPublicKeyBase64 = input.metadata?.signerPublicKey as string | undefined
  if (!signerPublicKeyBase64) {
    return { valid: false }
  }

  const publicKey = sodium.from_base64(signerPublicKeyBase64, sodium.base64_variants.ORIGINAL)
  const signature = sodium.from_base64(input.signature, sodium.base64_variants.ORIGINAL)

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
