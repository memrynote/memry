import { compressPayload } from '../compress.ts'
import type { SyncPushCryptoProvider } from './crypto-provider.ts'

/**
 * Platform-free twin of desktop's `encryptCrdtUpdate`
 * (`apps/desktop/src/main/sync/crdt-encrypt.ts`).
 *
 * Packed layout — the exact inverse of `decryptCrdtUpdatePacked`:
 *   [dataNonce(24) | keyNonce(24) | wrappedKey(48) | signature(64) | ciphertext]
 * signed over noteId ‖ header-without-signature ‖ ciphertext, with the AEAD
 * associated data being the noteId. A byte out of place here is an update that
 * every other device rejects, so the layout constants live in one place and
 * `crdt-roundtrip.test.ts` pins the pair.
 */

const NONCE_LEN = 24
const WRAPPED_KEY_LEN = 48
const SIGNATURE_LEN = 64
const HEADER_LEN = NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN + SIGNATURE_LEN

export function encryptCrdtUpdatePacked(
  crypto: SyncPushCryptoProvider,
  update: Uint8Array,
  vaultKey: Uint8Array,
  noteId: string,
  signingSecretKey: Uint8Array
): Uint8Array {
  const fileKey = crypto.generateFileKey()
  try {
    const compressed = compressPayload(update)
    const { ciphertext, nonce: dataNonce } = crypto.encrypt(compressed, fileKey, noteId)
    const { wrappedKey, nonce: keyNonce } = crypto.wrapFileKey(fileKey, vaultKey)

    const packed = new Uint8Array(HEADER_LEN + ciphertext.length)
    packed.set(dataNonce, 0)
    packed.set(keyNonce, NONCE_LEN)
    packed.set(wrappedKey, NONCE_LEN + NONCE_LEN)
    // signature slot at offset 72, filled below
    packed.set(ciphertext, HEADER_LEN)

    const signature = crypto.signDetached(buildSignedPayload(noteId, packed), signingSecretKey)
    packed.set(signature, NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN)

    return packed
  } finally {
    fileKey.fill(0)
  }
}

function buildSignedPayload(noteId: string, packed: Uint8Array): Uint8Array {
  const noteIdBytes = new TextEncoder().encode(noteId)
  const sigOffset = NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN
  const beforeSig = packed.subarray(0, sigOffset)
  const afterSig = packed.subarray(sigOffset + SIGNATURE_LEN)
  const payload = new Uint8Array(noteIdBytes.length + beforeSig.length + afterSig.length)
  payload.set(noteIdBytes, 0)
  payload.set(beforeSig, noteIdBytes.length)
  payload.set(afterSig, noteIdBytes.length + beforeSig.length)
  return payload
}
