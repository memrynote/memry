/**
 * Crypto IPC Handlers
 *
 * Handles IPC communication for cryptographic operations between the main
 * process and renderer. Provides entry points for encryption, decryption,
 * signing, key derivation, and recovery phrase management.
 *
 * @module main/ipc/crypto-handlers
 */

import { ipcMain } from 'electron'
import {
  CRYPTO_CHANNELS,
  SYNC_EVENTS,
  ValidateRecoveryPhraseInputSchema,
  ConfirmRecoveryPhraseInputSchema,
  EncryptItemInputSchema,
  DecryptItemInputSchema,
  SignDataInputSchema,
  VerifySignatureInputSchema,
  type GenerateRecoveryPhraseOutput,
  type EncryptItemOutput,
  type DecryptItemOutput,
  type SignDataOutput,
  type VerifySignatureOutput
} from '@shared/contracts/ipc-sync'
import type { RecoveryPhraseValidation, KeyRotationProgress } from '@shared/contracts/crypto'
import { createValidatedHandler, createHandler } from './validate'
import * as crypto from '../crypto'

// =============================================================================
// Handler Registration
// =============================================================================

/**
 * Register all crypto-related IPC handlers.
 *
 * These handlers expose cryptographic operations to the renderer process
 * in a secure manner through IPC.
 */
export function registerCryptoHandlers(): void {
  // --- Recovery Phrase ---
  ipcMain.handle(
    CRYPTO_CHANNELS.GENERATE_RECOVERY_PHRASE,
    createHandler(async (): Promise<GenerateRecoveryPhraseOutput> => {
      const phrase = crypto.generateRecoveryPhrase()
      const wordCount = phrase.split(' ').length
      return { phrase, wordCount }
    })
  )

  ipcMain.handle(
    CRYPTO_CHANNELS.VALIDATE_RECOVERY_PHRASE,
    createValidatedHandler(
      ValidateRecoveryPhraseInputSchema,
      async (input): Promise<RecoveryPhraseValidation> => {
        return crypto.validateRecoveryPhrase(input.phrase)
      }
    )
  )

  ipcMain.handle(
    CRYPTO_CHANNELS.CONFIRM_RECOVERY_PHRASE,
    createValidatedHandler(ConfirmRecoveryPhraseInputSchema, async (input) => {
      // Verify each confirmation word matches the phrase
      const isValid = crypto.verifyConfirmationWords(input.phrase, input.confirmationWords)
      return { success: isValid, error: isValid ? undefined : 'Confirmation words do not match' }
    })
  )

  // --- Key Operations ---
  ipcMain.handle(
    CRYPTO_CHANNELS.DERIVE_KEYS,
    createHandler(async () => {
      // TODO: Implement key derivation from stored master key
      // This will derive all keys (vault, signing, verify) from master key
      throw new Error('Not implemented: DERIVE_KEYS - requires master key in keychain')
    })
  )

  ipcMain.handle(
    CRYPTO_CHANNELS.GET_PUBLIC_KEY,
    createHandler(async () => {
      // TODO: Implement getting public signing key
      // Returns the Ed25519 public key for signature verification
      throw new Error('Not implemented: GET_PUBLIC_KEY - requires derived keys')
    })
  )

  // --- Encryption/Decryption ---
  ipcMain.handle(
    CRYPTO_CHANNELS.ENCRYPT_ITEM,
    createValidatedHandler(EncryptItemInputSchema, async (input): Promise<EncryptItemOutput> => {
      // Get the vault key from keychain/derived keys
      const masterKey = await crypto.getMasterKey()
      if (!masterKey) {
        throw new Error('Master key not found - user must be logged in')
      }

      // Derive vault key from master key
      const vaultKey = crypto.deriveVaultKey(masterKey)

      // Encrypt the item data
      const dataBuffer = Buffer.from(input.data, 'utf-8')
      const result = crypto.encryptItem(dataBuffer, vaultKey)

      // Get signing key and sign the encrypted data
      const signingKeySeed = crypto.deriveSigningKeySeed(masterKey)
      const { secretKey } = crypto.generateSigningKeyPair(signingKeySeed)

      // Create signature over the encrypted payload
      const signaturePayload = crypto.createSignaturePayload({
        id: 'temp', // Will be replaced by actual item ID in real implementation
        type: input.type,
        cryptoVersion: result.cryptoVersion,
        encryptedKey: result.encryptedKey.toString('base64'),
        keyNonce: result.keyNonce.toString('base64'),
        encryptedData: result.encryptedData.toString('base64'),
        dataNonce: result.dataNonce.toString('base64')
      })
      const signature = crypto.signToBase64(signaturePayload, secretKey)

      return {
        encryptedData: result.encryptedData.toString('base64'),
        nonce: result.dataNonce.toString('base64'),
        encryptedKey: result.encryptedKey.toString('base64'),
        keyNonce: result.keyNonce.toString('base64'),
        signature
      }
    })
  )

  ipcMain.handle(
    CRYPTO_CHANNELS.DECRYPT_ITEM,
    createValidatedHandler(DecryptItemInputSchema, async (input): Promise<DecryptItemOutput> => {
      // Get the master key from keychain
      const masterKey = await crypto.getMasterKey()
      if (!masterKey) {
        throw new Error('Master key not found - user must be logged in')
      }

      // Derive vault key from master key
      const vaultKey = crypto.deriveVaultKey(masterKey)

      // Derive signing key and get public key for verification
      const signingKeySeed = crypto.deriveSigningKeySeed(masterKey)
      const { publicKey } = crypto.generateSigningKeyPair(signingKeySeed)

      // Verify the signature first
      const encryptedData = Buffer.from(input.encryptedData, 'base64')
      const nonce = Buffer.from(input.nonce, 'base64')
      const encryptedKey = Buffer.from(input.encryptedKey, 'base64')
      const keyNonce = Buffer.from(input.keyNonce, 'base64')

      const signaturePayload = crypto.createSignaturePayload({
        id: 'temp', // Will be replaced by actual item ID in real implementation
        type: 'note', // Default type for verification
        cryptoVersion: 1,
        encryptedKey: input.encryptedKey,
        keyNonce: input.keyNonce,
        encryptedData: input.encryptedData,
        dataNonce: input.nonce
      })

      const verified = crypto.verifyFromBase64(input.signature, signaturePayload, publicKey)

      // Decrypt the item
      const decryptedBuffer = crypto.decryptItem(
        encryptedData,
        nonce,
        encryptedKey,
        keyNonce,
        vaultKey
      )

      return {
        data: decryptedBuffer.toString('utf-8'),
        verified
      }
    })
  )

  ipcMain.handle(
    CRYPTO_CHANNELS.ENCRYPT_BLOB,
    createHandler(async () => {
      // TODO: Implement blob encryption for attachments
      // Uses chunked encryption for large files
      throw new Error('Not implemented: ENCRYPT_BLOB')
    })
  )

  ipcMain.handle(
    CRYPTO_CHANNELS.DECRYPT_BLOB,
    createHandler(async () => {
      // TODO: Implement blob decryption for attachments
      // Uses chunked decryption for large files
      throw new Error('Not implemented: DECRYPT_BLOB')
    })
  )

  // --- Signatures ---
  ipcMain.handle(
    CRYPTO_CHANNELS.SIGN_DATA,
    createValidatedHandler(SignDataInputSchema, async (input): Promise<SignDataOutput> => {
      // Get the master key from keychain
      const masterKey = await crypto.getMasterKey()
      if (!masterKey) {
        throw new Error('Master key not found - user must be logged in')
      }

      // Derive signing key
      const signingKeySeed = crypto.deriveSigningKeySeed(masterKey)
      const { secretKey } = crypto.generateSigningKeyPair(signingKeySeed)

      // Parse the data and sign it
      const dataToSign = JSON.parse(input.data)
      const signature = crypto.signToBase64(dataToSign, secretKey)

      return { signature }
    })
  )

  ipcMain.handle(
    CRYPTO_CHANNELS.VERIFY_SIGNATURE,
    createValidatedHandler(
      VerifySignatureInputSchema,
      async (input): Promise<VerifySignatureOutput> => {
        let publicKey: Buffer

        if (input.publicKey) {
          // Use provided public key
          publicKey = Buffer.from(input.publicKey, 'base64')
        } else {
          // Use current user's public key
          const masterKey = await crypto.getMasterKey()
          if (!masterKey) {
            return { valid: false, error: 'Master key not found - user must be logged in' }
          }

          const signingKeySeed = crypto.deriveSigningKeySeed(masterKey)
          const keyPair = crypto.generateSigningKeyPair(signingKeySeed)
          publicKey = keyPair.publicKey
        }

        try {
          const dataToVerify = JSON.parse(input.data)
          const valid = crypto.verifyFromBase64(input.signature, dataToVerify, publicKey)
          return { valid }
        } catch (error) {
          return {
            valid: false,
            error: error instanceof Error ? error.message : 'Verification failed'
          }
        }
      }
    )
  )

  // --- Key Rotation ---
  ipcMain.handle(
    CRYPTO_CHANNELS.START_KEY_ROTATION,
    createHandler(async () => {
      // TODO: Implement key rotation in Phase 4+ (P2 MVP)
      // This is a complex operation that re-encrypts all data with new keys
      throw new Error('Not implemented: START_KEY_ROTATION')
    })
  )

  ipcMain.handle(
    CRYPTO_CHANNELS.GET_ROTATION_PROGRESS,
    createHandler(async (): Promise<KeyRotationProgress | null> => {
      // TODO: Implement key rotation progress tracking
      return null
    })
  )

  ipcMain.handle(
    CRYPTO_CHANNELS.CANCEL_KEY_ROTATION,
    createHandler(async () => {
      // TODO: Implement key rotation cancellation
      return { success: true }
    })
  )

  // --- Keychain ---
  ipcMain.handle(
    CRYPTO_CHANNELS.HAS_MASTER_KEY,
    createHandler(async () => {
      const hasMasterKey = await crypto.hasMasterKey()
      return { hasMasterKey }
    })
  )

  ipcMain.handle(
    CRYPTO_CHANNELS.CLEAR_KEYCHAIN,
    createHandler(async () => {
      await crypto.clearAllKeychainEntries()
      return { success: true }
    })
  )

  console.log('[IPC] Crypto handlers registered')
}

/**
 * Unregister all crypto-related IPC handlers.
 */
export function unregisterCryptoHandlers(): void {
  // Remove all crypto channel handlers
  Object.values(CRYPTO_CHANNELS).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })

  console.log('[IPC] Crypto handlers unregistered')
}

// =============================================================================
// Event Emitters (for main -> renderer communication)
// =============================================================================

/**
 * Emit key rotation progress event to renderer.
 *
 * @param webContents - Target webContents
 * @param progress - Rotation progress data
 */
export function emitKeyRotationProgress(
  webContents: Electron.WebContents,
  progress: KeyRotationProgress
): void {
  webContents.send(SYNC_EVENTS.KEY_ROTATION_PROGRESS, progress)
}
