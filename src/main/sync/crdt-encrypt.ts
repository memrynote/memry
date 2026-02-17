import { encrypt, decrypt, wrapFileKey, unwrapFileKey } from '../crypto/encryption'
import { generateFileKey, secureCleanup } from '../crypto/index'

const NONCE_LEN = 24
const WRAPPED_KEY_LEN = 48
const HEADER_LEN = NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN

export function encryptCrdtUpdate(update: Uint8Array, vaultKey: Uint8Array): Uint8Array {
  const fileKey = generateFileKey()

  try {
    const { ciphertext, nonce: dataNonce } = encrypt(update, fileKey)
    const { wrappedKey, nonce: keyNonce } = wrapFileKey(fileKey, vaultKey)

    const packed = new Uint8Array(HEADER_LEN + ciphertext.length)
    packed.set(dataNonce, 0)
    packed.set(keyNonce, NONCE_LEN)
    packed.set(wrappedKey, NONCE_LEN + NONCE_LEN)
    packed.set(ciphertext, HEADER_LEN)

    return packed
  } finally {
    secureCleanup(fileKey)
  }
}

export function decryptCrdtUpdate(packed: Uint8Array, vaultKey: Uint8Array): Uint8Array {
  if (packed.length < HEADER_LEN + 1) {
    throw new Error(`CRDT update too short: ${packed.length} bytes`)
  }

  const dataNonce = packed.subarray(0, NONCE_LEN)
  const keyNonce = packed.subarray(NONCE_LEN, NONCE_LEN + NONCE_LEN)
  const wrappedKey = packed.subarray(NONCE_LEN + NONCE_LEN, HEADER_LEN)
  const ciphertext = packed.subarray(HEADER_LEN)

  const fileKey = unwrapFileKey(wrappedKey, keyNonce, vaultKey)
  try {
    return decrypt(ciphertext, dataNonce, fileKey)
  } finally {
    secureCleanup(fileKey)
  }
}
