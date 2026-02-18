import sodium from 'libsodium-wrappers-sumo'
import { encrypt, decrypt, wrapFileKey, unwrapFileKey } from '../crypto/encryption'
import { generateFileKey, secureCleanup } from '../crypto/index'
import { compressPayload, decompressPayload } from './compress'
import { SignatureVerificationError } from './decrypt'

const NONCE_LEN = 24
const WRAPPED_KEY_LEN = 48
const SIGNATURE_LEN = 64
const HEADER_LEN = NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN + SIGNATURE_LEN

export function encryptCrdtUpdate(
  update: Uint8Array,
  vaultKey: Uint8Array,
  noteId: string,
  signingSecretKey: Uint8Array
): Uint8Array {
  const fileKey = generateFileKey()
  const noteIdBytes = new TextEncoder().encode(noteId)

  try {
    const compressed = compressPayload(update)
    const { ciphertext, nonce: dataNonce } = encrypt(compressed, fileKey, noteIdBytes)
    const { wrappedKey, nonce: keyNonce } = wrapFileKey(fileKey, vaultKey)

    const packedLen = HEADER_LEN + ciphertext.length
    const packed = new Uint8Array(packedLen)
    packed.set(dataNonce, 0)
    packed.set(keyNonce, NONCE_LEN)
    packed.set(wrappedKey, NONCE_LEN + NONCE_LEN)
    // signature slot at offset 72, filled below
    packed.set(ciphertext, HEADER_LEN)

    const bodyToSign = buildSignedPayload(noteIdBytes, packed)
    const signature = sodium.crypto_sign_detached(bodyToSign, signingSecretKey)
    packed.set(signature, NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN)

    return packed
  } finally {
    secureCleanup(fileKey)
  }
}

export function decryptCrdtUpdate(
  packed: Uint8Array,
  vaultKey: Uint8Array,
  noteId: string,
  signerPublicKey: Uint8Array
): Uint8Array {
  if (packed.length < HEADER_LEN + 1) {
    throw new Error(`CRDT update too short: ${packed.length} bytes`)
  }

  const noteIdBytes = new TextEncoder().encode(noteId)
  const signature = packed.subarray(
    NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN,
    NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN + SIGNATURE_LEN
  )

  const bodyToVerify = buildSignedPayload(noteIdBytes, packed)
  const valid = sodium.crypto_sign_verify_detached(signature, bodyToVerify, signerPublicKey)
  if (!valid) {
    const keyHex = sodium.to_hex(signerPublicKey).slice(0, 16)
    throw new SignatureVerificationError(noteId, `pubkey:${keyHex}`)
  }

  const dataNonce = packed.subarray(0, NONCE_LEN)
  const keyNonce = packed.subarray(NONCE_LEN, NONCE_LEN + NONCE_LEN)
  const wrappedKey = packed.subarray(NONCE_LEN + NONCE_LEN, NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN)
  const ciphertext = packed.subarray(HEADER_LEN)

  const fileKey = unwrapFileKey(wrappedKey, keyNonce, vaultKey)
  try {
    const compressed = decrypt(ciphertext, dataNonce, fileKey, noteIdBytes)
    return decompressPayload(compressed)
  } finally {
    secureCleanup(fileKey)
  }
}

function buildSignedPayload(noteIdBytes: Uint8Array, packed: Uint8Array): Uint8Array {
  const sigOffset = NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN
  const beforeSig = packed.subarray(0, sigOffset)
  const afterSig = packed.subarray(sigOffset + SIGNATURE_LEN)
  const payload = new Uint8Array(noteIdBytes.length + beforeSig.length + afterSig.length)
  payload.set(noteIdBytes, 0)
  payload.set(beforeSig, noteIdBytes.length)
  payload.set(afterSig, noteIdBytes.length + beforeSig.length)
  return payload
}
