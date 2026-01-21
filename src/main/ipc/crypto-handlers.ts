/**
 * Crypto IPC handlers.
 * Handles all cryptographic operations from renderer.
 *
 * @module ipc/crypto-handlers
 */

import { ipcMain, BrowserWindow } from 'electron'
import {
  CryptoChannels,
  EncryptItemRequestSchema,
  DeriveKeysRequestSchema
} from '@shared/contracts/ipc-sync'
import type {
  HasKeysResponse,
  DeriveKeysResponse,
  EncryptItemRequest,
  EncryptItemResponse,
  DecryptItemRequest,
  DecryptItemResponse,
  SignItemResponse,
  VerifySignatureRequest,
  VerifySignatureResponse
} from '@shared/contracts/ipc-sync'
import type { EncryptedItem, SignaturePayloadV1 } from '@shared/contracts/crypto'
import { CRYPTO_VERSION, EncryptedItemSchema } from '@shared/contracts/crypto'
import { createValidatedHandler, createHandler } from './validate'
import { z } from 'zod'

import {
  generateRecoveryPhrase,
  validateRecoveryPhrase,
  phraseToEntropy,
  deriveMasterKey,
  deriveAllKeys,
  generateFileKey,
  uint8ArrayToBase64,
  base64ToUint8Array,
  encryptWithWrappedKey,
  decryptWithWrappedKey,
  signPayloadBase64,
  verifyPayload,
  retrieveKeyMaterial,
  deleteKeyMaterial,
  hasKeyMaterial,
  retrieveDeviceKeyPair,
  isCryptoError,
  secureZero
} from '../crypto'

async function zeroDerivedKeys(keys: {
  vaultKey: Uint8Array
  signingKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array }
  verifyKey: Uint8Array
}): Promise<void> {
  await secureZero(keys.vaultKey)
  await secureZero(keys.signingKeyPair.publicKey)
  await secureZero(keys.signingKeyPair.privateKey)
  await secureZero(keys.verifyKey)
}

function emitCryptoEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

export function registerCryptoHandlers(): void {
  // ============================================================================
  // Key Management
  // ============================================================================

  ipcMain.handle(
    CryptoChannels.invoke.HAS_KEYS,
    createHandler(async (): Promise<HasKeysResponse> => {
      try {
        const hasKeys = await hasKeyMaterial()
        if (!hasKeys) {
          return { hasKeys: false }
        }

        const material = await retrieveKeyMaterial()
        return {
          hasKeys: true,
          deviceId: material?.deviceId,
          userId: material?.userId
        }
      } catch (error) {
        console.error('[Crypto] hasKeys error:', error)
        return { hasKeys: false }
      }
    })
  )

  ipcMain.handle(
    CryptoChannels.invoke.GENERATE_RECOVERY_PHRASE,
    createHandler((): { phrase: string[] } => {
      try {
        const phrase = generateRecoveryPhrase()
        return { phrase }
      } catch (error) {
        console.error('[Crypto] generateRecoveryPhrase error:', error)
        throw error
      }
    })
  )

  ipcMain.handle(
    CryptoChannels.invoke.DERIVE_KEYS,
    createValidatedHandler(DeriveKeysRequestSchema, async (input): Promise<DeriveKeysResponse> => {
      let entropy: Uint8Array | null = null
      let masterKey: Uint8Array | null = null
      let derivedKeys: Awaited<ReturnType<typeof deriveAllKeys>> | null = null

      try {
        const isValid = validateRecoveryPhrase(input.phrase)
        if (!isValid) {
          return { success: false, error: 'Invalid recovery phrase' }
        }

        entropy = phraseToEntropy(input.phrase)
        const kdfSalt = base64ToUint8Array(input.kdfSalt)
        masterKey = deriveMasterKey(entropy, kdfSalt)
        derivedKeys = await deriveAllKeys(masterKey)

        const keyVerifier = uint8ArrayToBase64(derivedKeys.verifyKey)

        return {
          success: true,
          keyVerifier
        }
      } catch (error) {
        const message = isCryptoError(error) ? error.message : 'Key derivation failed'
        return { success: false, error: message }
      } finally {
        if (entropy) await secureZero(entropy)
        if (masterKey) await secureZero(masterKey)
        if (derivedKeys) await zeroDerivedKeys(derivedKeys)
      }
    })
  )

  ipcMain.handle(
    CryptoChannels.invoke.VERIFY_MASTER_KEY,
    createValidatedHandler(
      z.object({ keyVerifier: z.string() }),
      async (input): Promise<{ valid: boolean }> => {
        let masterKey: Uint8Array | null = null
        let derivedKeys: Awaited<ReturnType<typeof deriveAllKeys>> | null = null

        try {
          const material = await retrieveKeyMaterial()
          if (!material) {
            return { valid: false }
          }

          masterKey = base64ToUint8Array(material.masterKey)
          derivedKeys = await deriveAllKeys(masterKey)
          const computedVerifier = uint8ArrayToBase64(derivedKeys.verifyKey)

          return { valid: computedVerifier === input.keyVerifier }
        } catch (error) {
          console.error('[Crypto] verifyMasterKey error:', error)
          return { valid: false }
        } finally {
          if (masterKey) await secureZero(masterKey)
          if (derivedKeys) await zeroDerivedKeys(derivedKeys)
        }
      }
    )
  )

  ipcMain.handle(
    CryptoChannels.invoke.STORE_KEYS,
    createHandler((): { success: boolean } => {
      return { success: false }
    })
  )

  ipcMain.handle(
    CryptoChannels.invoke.RETRIEVE_KEYS,
    createHandler(async (): Promise<{ success: boolean; hasKeys: boolean }> => {
      try {
        const hasKeys = await hasKeyMaterial()
        return { success: true, hasKeys }
      } catch (error) {
        console.error('[Crypto] retrieveKeys error:', error)
        return { success: false, hasKeys: false }
      }
    })
  )

  ipcMain.handle(
    CryptoChannels.invoke.DELETE_KEYS,
    createHandler(async (): Promise<{ success: boolean }> => {
      try {
        await deleteKeyMaterial()
        emitCryptoEvent(CryptoChannels.events.KEYS_DELETED, {})
        return { success: true }
      } catch (error) {
        console.error('[Crypto] deleteKeys error:', error)
        return { success: false }
      }
    })
  )

  // ============================================================================
  // Encryption/Decryption
  // ============================================================================

  ipcMain.handle(
    CryptoChannels.invoke.ENCRYPT_ITEM,
    createValidatedHandler(
      EncryptItemRequestSchema,
      async (input: EncryptItemRequest): Promise<EncryptItemResponse> => {
        let masterKey: Uint8Array | null = null
        let derivedKeys: Awaited<ReturnType<typeof deriveAllKeys>> | null = null
        let fileKey: Uint8Array | null = null

        try {
          const material = await retrieveKeyMaterial()
          if (!material) {
            return { success: false, error: 'No keys available. Please set up sync first.' }
          }

          const deviceKeyPair = await retrieveDeviceKeyPair()
          if (!deviceKeyPair) {
            return {
              success: false,
              error: 'No device keypair available. Please set up sync first.'
            }
          }

          masterKey = base64ToUint8Array(material.masterKey)
          derivedKeys = await deriveAllKeys(masterKey)
          const vaultKey = derivedKeys.vaultKey

          fileKey = await generateFileKey()

          const plaintext = new TextEncoder().encode(input.data)

          const encrypted = await encryptWithWrappedKey(plaintext, fileKey, vaultKey)

          const signaturePayload: SignaturePayloadV1 = {
            id: input.id,
            type: input.type,
            operation: input.operation,
            cryptoVersion: CRYPTO_VERSION,
            encryptedKey: encrypted.encryptedKey,
            keyNonce: encrypted.keyNonce,
            encryptedData: encrypted.encryptedData,
            dataNonce: encrypted.dataNonce
          }

          const signature = await signPayloadBase64(
            signaturePayload,
            deviceKeyPair.privateKey,
            deviceKeyPair.deviceId
          )

          const encryptedItem: EncryptedItem = {
            id: input.id,
            type: input.type as EncryptedItem['type'],
            cryptoVersion: CRYPTO_VERSION,
            encryptedKey: encrypted.encryptedKey,
            keyNonce: encrypted.keyNonce,
            encryptedData: encrypted.encryptedData,
            dataNonce: encrypted.dataNonce,
            signature,
            signerDeviceId: deviceKeyPair.deviceId,
            signedAt: Date.now()
          }

          return { success: true, item: encryptedItem }
        } catch (error) {
          console.error('[Crypto] encryptItem error:', error)
          const message = isCryptoError(error) ? error.message : 'Encryption failed'
          return { success: false, error: message }
        } finally {
          if (masterKey) await secureZero(masterKey)
          if (derivedKeys) await zeroDerivedKeys(derivedKeys)
          if (fileKey) await secureZero(fileKey)
        }
      }
    )
  )

  ipcMain.handle(
    CryptoChannels.invoke.DECRYPT_ITEM,
    createValidatedHandler(
      z.object({ item: EncryptedItemSchema }),
      async (input: DecryptItemRequest): Promise<DecryptItemResponse> => {
        let masterKey: Uint8Array | null = null
        let derivedKeys: Awaited<ReturnType<typeof deriveAllKeys>> | null = null

        try {
          const material = await retrieveKeyMaterial()
          if (!material) {
            return { success: false, error: 'No keys available. Please set up sync first.' }
          }

          masterKey = base64ToUint8Array(material.masterKey)
          derivedKeys = await deriveAllKeys(masterKey)
          const vaultKey = derivedKeys.vaultKey

          const { item } = input

          const plaintext = await decryptWithWrappedKey(
            item.encryptedData,
            item.dataNonce,
            item.encryptedKey,
            item.keyNonce,
            vaultKey
          )

          const data = new TextDecoder().decode(plaintext)

          return { success: true, data }
        } catch (error) {
          console.error('[Crypto] decryptItem error:', error)
          const message = isCryptoError(error) ? error.message : 'Decryption failed'
          return { success: false, error: message }
        } finally {
          if (masterKey) await secureZero(masterKey)
          if (derivedKeys) await zeroDerivedKeys(derivedKeys)
        }
      }
    )
  )

  ipcMain.handle(
    CryptoChannels.invoke.ENCRYPT_ATTACHMENT,
    createHandler(() => ({ success: false, error: 'Not implemented' }))
  )

  ipcMain.handle(
    CryptoChannels.invoke.DECRYPT_ATTACHMENT,
    createHandler(() => ({ success: false, error: 'Not implemented' }))
  )

  // ============================================================================
  // Signatures
  // ============================================================================

  ipcMain.handle(
    CryptoChannels.invoke.SIGN_ITEM,
    createValidatedHandler(
      z.object({ item: EncryptedItemSchema }),
      async (input: { item: EncryptedItem }): Promise<SignItemResponse> => {
        try {
          const deviceKeyPair = await retrieveDeviceKeyPair()
          if (!deviceKeyPair) {
            return { success: false, error: 'No device keypair available' }
          }

          const { item } = input

          const signaturePayload: SignaturePayloadV1 = {
            id: item.id,
            type: item.type,
            cryptoVersion: item.cryptoVersion,
            encryptedKey: item.encryptedKey,
            keyNonce: item.keyNonce,
            encryptedData: item.encryptedData,
            dataNonce: item.dataNonce
          }

          const signature = await signPayloadBase64(
            signaturePayload,
            deviceKeyPair.privateKey,
            deviceKeyPair.deviceId
          )

          return {
            success: true,
            signature,
            signerDeviceId: deviceKeyPair.deviceId
          }
        } catch (error) {
          console.error('[Crypto] signItem error:', error)
          const message = isCryptoError(error) ? error.message : 'Signing failed'
          return { success: false, error: message }
        }
      }
    )
  )

  ipcMain.handle(
    CryptoChannels.invoke.VERIFY_SIGNATURE,
    createValidatedHandler(
      z.object({
        item: EncryptedItemSchema,
        signerPublicKey: z.string()
      }),
      async (input: VerifySignatureRequest): Promise<VerifySignatureResponse> => {
        try {
          const { item, signerPublicKey } = input

          const signaturePayload: SignaturePayloadV1 = {
            id: item.id,
            type: item.type,
            cryptoVersion: item.cryptoVersion,
            encryptedKey: item.encryptedKey,
            keyNonce: item.keyNonce,
            encryptedData: item.encryptedData,
            dataNonce: item.dataNonce
          }

          // Include metadata only if clock data exists (for CRDT sync items)
          // This must match how the item was originally signed
          if (item.clock || item.fieldClocks) {
            signaturePayload.metadata = {
              clock: item.clock,
              fieldClocks: item.fieldClocks
            }
          }

          const result = await verifyPayload(signaturePayload, item.signature, signerPublicKey)

          return result
        } catch (error) {
          console.error('[Crypto] verifySignature error:', error)
          const message = error instanceof Error ? error.message : 'Verification failed'
          return { valid: false, error: message }
        }
      }
    )
  )

  // ============================================================================
  // Device Linking Crypto
  // ============================================================================

  ipcMain.handle(
    CryptoChannels.invoke.GENERATE_LINKING_KEYPAIR,
    createHandler(() => ({ success: false, error: 'Not implemented' }))
  )

  ipcMain.handle(
    CryptoChannels.invoke.DERIVE_LINKING_KEYS,
    createHandler(() => ({ success: false, error: 'Not implemented' }))
  )

  ipcMain.handle(
    CryptoChannels.invoke.ENCRYPT_MASTER_KEY,
    createHandler(() => ({ success: false, error: 'Not implemented' }))
  )

  ipcMain.handle(
    CryptoChannels.invoke.DECRYPT_MASTER_KEY,
    createHandler(() => ({ success: false, error: 'Not implemented' }))
  )

  ipcMain.handle(
    CryptoChannels.invoke.COMPUTE_LINKING_PROOF,
    createHandler(() => ({ success: false, error: 'Not implemented' }))
  )

  ipcMain.handle(
    CryptoChannels.invoke.VERIFY_LINKING_PROOF,
    createHandler(() => ({ success: false, error: 'Not implemented' }))
  )

  console.log('[IPC] Crypto handlers registered')
}

export function unregisterCryptoHandlers(): void {
  Object.values(CryptoChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })
  console.log('[IPC] Crypto handlers unregistered')
}

// Exported for use by crypto module to emit key lifecycle events to renderer
export { emitCryptoEvent }
