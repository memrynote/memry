/**
 * Ed25519 Signature Module
 *
 * Implements Ed25519 signing and verification over canonical CBOR payloads.
 */

import { ensureSodiumReady } from './sodium'
import { CryptoError, CryptoErrorCode } from './errors'
import { encodeSignaturePayloadV1 } from './cbor'
import { uint8ArrayToBase64, base64ToUint8Array } from './keys'
import { ED25519_PARAMS } from '@shared/contracts/crypto'
import type {
  SignaturePayloadV1,
  SignatureResult,
  VerificationResult
} from '@shared/contracts/crypto'

/**
 * Sign a signature payload with an Ed25519 private key.
 *
 * @param payload - The payload to sign
 * @param privateKey - Ed25519 private key (64 bytes)
 * @param deviceId - The device ID of the signer
 * @returns Signature result with signature and device ID
 * @throws CryptoError if signing fails
 */
export async function signPayload(
  payload: SignaturePayloadV1,
  privateKey: Uint8Array,
  deviceId: string
): Promise<SignatureResult> {
  const sodium = await ensureSodiumReady()

  if (privateKey.length !== ED25519_PARAMS.privateKeySize) {
    throw new CryptoError(
      `Invalid private key length: expected ${ED25519_PARAMS.privateKeySize} bytes, got ${privateKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    )
  }

  try {
    // Encode payload to canonical CBOR
    const message = encodeSignaturePayloadV1(payload)

    // Sign the encoded message
    const signature = sodium.crypto_sign_detached(message, privateKey) as Uint8Array

    return {
      signature,
      signerDeviceId: deviceId
    }
  } catch (error) {
    if (error instanceof CryptoError) throw error
    throw new CryptoError('Signing failed', CryptoErrorCode.SIGNATURE_INVALID, error)
  }
}

/**
 * Verify a signature over a payload.
 *
 * @param payload - The payload that was signed
 * @param signature - The signature to verify (Uint8Array or Base64)
 * @param publicKey - Ed25519 public key (Uint8Array or Base64)
 * @returns Verification result
 */
export async function verifyPayload(
  payload: SignaturePayloadV1,
  signature: Uint8Array | string,
  publicKey: Uint8Array | string
): Promise<VerificationResult> {
  const sodium = await ensureSodiumReady()

  // Convert from Base64 if needed
  const sigBytes = typeof signature === 'string' ? base64ToUint8Array(signature) : signature
  const pubKeyBytes = typeof publicKey === 'string' ? base64ToUint8Array(publicKey) : publicKey

  if (sigBytes.length !== ED25519_PARAMS.signatureSize) {
    return {
      valid: false,
      error: `Invalid signature length: expected ${ED25519_PARAMS.signatureSize} bytes, got ${sigBytes.length}`
    }
  }

  if (pubKeyBytes.length !== ED25519_PARAMS.publicKeySize) {
    return {
      valid: false,
      error: `Invalid public key length: expected ${ED25519_PARAMS.publicKeySize} bytes, got ${pubKeyBytes.length}`
    }
  }

  try {
    // Encode payload to canonical CBOR
    const message = encodeSignaturePayloadV1(payload)

    // Verify the signature
    const valid = sodium.crypto_sign_verify_detached(sigBytes, message, pubKeyBytes) as boolean

    return { valid }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Verification failed'
    }
  }
}

/**
 * Sign arbitrary data with an Ed25519 private key.
 *
 * @param data - Data to sign
 * @param privateKey - Ed25519 private key (64 bytes)
 * @returns Signature (64 bytes)
 * @throws CryptoError if signing fails
 */
export async function sign(data: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
  const sodium = await ensureSodiumReady()

  if (privateKey.length !== ED25519_PARAMS.privateKeySize) {
    throw new CryptoError(
      `Invalid private key length: expected ${ED25519_PARAMS.privateKeySize} bytes, got ${privateKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    )
  }

  try {
    return sodium.crypto_sign_detached(data, privateKey) as Uint8Array
  } catch (error) {
    throw new CryptoError('Signing failed', CryptoErrorCode.SIGNATURE_INVALID, error)
  }
}

/**
 * Verify a signature over arbitrary data.
 *
 * @param data - Data that was signed
 * @param signature - Signature to verify
 * @param publicKey - Ed25519 public key
 * @returns true if valid, false otherwise
 */
export async function verify(
  data: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): Promise<boolean> {
  const sodium = await ensureSodiumReady()

  if (signature.length !== ED25519_PARAMS.signatureSize) {
    return false
  }

  if (publicKey.length !== ED25519_PARAMS.publicKeySize) {
    return false
  }

  try {
    return sodium.crypto_sign_verify_detached(signature, data, publicKey) as boolean
  } catch {
    return false
  }
}

/**
 * Sign a payload and return a Base64-encoded signature.
 * Convenience function for creating signed items.
 *
 * @param payload - The payload to sign
 * @param privateKey - Ed25519 private key (64 bytes)
 * @param deviceId - The device ID of the signer
 * @returns Base64-encoded signature
 */
export async function signPayloadBase64(
  payload: SignaturePayloadV1,
  privateKey: Uint8Array,
  deviceId: string
): Promise<string> {
  const result = await signPayload(payload, privateKey, deviceId)
  return uint8ArrayToBase64(result.signature)
}
