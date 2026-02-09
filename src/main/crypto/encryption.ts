import sodium from 'libsodium-wrappers-sumo'

import { XCHACHA20_PARAMS } from '@shared/contracts/crypto'

export const generateNonce = (): Uint8Array => {
  const nonce = sodium.randombytes_buf(XCHACHA20_PARAMS.NONCE_LENGTH)

  if (nonce.length !== XCHACHA20_PARAMS.NONCE_LENGTH) {
    throw new Error(
      `Nonce length mismatch: expected ${XCHACHA20_PARAMS.NONCE_LENGTH}, got ${nonce.length}`
    )
  }

  return nonce
}

export const encrypt = (
  plaintext: Uint8Array,
  key: Uint8Array,
  associatedData?: Uint8Array
): { ciphertext: Uint8Array; nonce: Uint8Array } => {
  const nonce = generateNonce()

  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    associatedData ?? null,
    null,
    nonce,
    key
  )

  return { ciphertext, nonce }
}

export const decrypt = (
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
  associatedData?: Uint8Array
): Uint8Array => {
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    associatedData ?? null,
    nonce,
    key
  )
}

export const wrapFileKey = (
  fileKey: Uint8Array,
  vaultKey: Uint8Array
): { wrappedKey: Uint8Array; nonce: Uint8Array } => {
  const result = encrypt(fileKey, vaultKey)
  return { wrappedKey: result.ciphertext, nonce: result.nonce }
}

export const unwrapFileKey = (
  wrappedKey: Uint8Array,
  nonce: Uint8Array,
  vaultKey: Uint8Array
): Uint8Array => {
  const fileKey = decrypt(wrappedKey, nonce, vaultKey)

  try {
    return new Uint8Array(fileKey)
  } finally {
    sodium.memzero(fileKey)
  }
}
