/**
 * Mobile crypto module (spec 001-mobile-app T012 / R1) over the parity-proven
 * react-native-libsodium JSI binding (+ the crypto_scalarmult patch in
 * patches/react-native-libsodium@1.7.0.patch).
 *
 * Mirrors the desktop surface built on @memry/contracts/crypto
 * (apps/desktop/src/main/crypto/{keys,encryption,primitives}.ts) so
 * @memry/sync-client can run unchanged on either shell. Byte parity with
 * desktop is proven by the vector harness (src/crypto/__harness__) — G0-a.
 *
 * Binding constraint: the JSI AEAD accepts associated data only as a string
 * (Uint8Array AD throws). Vault payload encryption never uses binary AD today;
 * this module exposes string AD and '' (== libsodium NULL/0) for none.
 */
import sodium from 'react-native-libsodium'

import {
  ARGON2_PARAMS,
  KEY_DERIVATION_CONTEXTS,
  LINKING_HKDF_CONTEXTS,
  XCHACHA20_PARAMS,
  type MasterKeyMaterial,
  type SigningKeyPair
} from '@memry/contracts/crypto'

// Same (ctx, id) mapping as desktop keys.ts — parity-critical.
const KDF_CONTEXT_MAP: Record<string, { ctx: string; id: number }> = {
  [KEY_DERIVATION_CONTEXTS.VAULT_KEY]: { ctx: 'memryvlt', id: 1 },
  'memry-signing-key-v1': { ctx: 'memrysgn', id: 2 },
  'memry-verify-key-v1': { ctx: 'memryvrf', id: 3 },
  [KEY_DERIVATION_CONTEXTS.KEY_VERIFIER]: { ctx: 'memrykve', id: 4 },
  [LINKING_HKDF_CONTEXTS.ENCRYPTION]: { ctx: 'memrylnk', id: 5 },
  [LINKING_HKDF_CONTEXTS.MAC]: { ctx: 'memrymac', id: 6 },
  [LINKING_HKDF_CONTEXTS.SAS]: { ctx: 'memrysas', id: 7 }
}

export const deriveKey = async (
  masterKey: Uint8Array,
  context: string,
  length: number
): Promise<Uint8Array> => {
  await sodium.ready

  const mapping = KDF_CONTEXT_MAP[context]
  if (!mapping) {
    throw new Error(`Unknown key derivation context: ${context}`)
  }
  return sodium.crypto_kdf_derive_from_key(length, mapping.id, mapping.ctx, masterKey)
}

export const generateKeyVerifier = async (masterKey: Uint8Array): Promise<string> => {
  const verifierKey = await deriveKey(masterKey, KEY_DERIVATION_CONTEXTS.KEY_VERIFIER, 32)
  return sodium.to_base64(verifierKey, sodium.base64_variants.ORIGINAL)
}

export const deriveMasterKey = async (
  seed: Uint8Array,
  salt: Uint8Array
): Promise<MasterKeyMaterial> => {
  await sodium.ready

  const masterKey = sodium.crypto_pwhash(
    32,
    seed,
    salt,
    ARGON2_PARAMS.OPS_LIMIT,
    ARGON2_PARAMS.MEMORY_LIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )

  const keyVerifier = await generateKeyVerifier(masterKey)

  return {
    masterKey,
    kdfSalt: sodium.to_base64(salt, sodium.base64_variants.ORIGINAL),
    keyVerifier
  }
}

export const generateSalt = (): Uint8Array => {
  return sodium.randombytes_buf(ARGON2_PARAMS.SALT_LENGTH)
}

export const generateNonce = (): Uint8Array => {
  return sodium.randombytes_buf(XCHACHA20_PARAMS.NONCE_LENGTH)
}

export const generateFileKey = (): Uint8Array => {
  return sodium.randombytes_buf(XCHACHA20_PARAMS.KEY_LENGTH)
}

export const encrypt = (
  plaintext: Uint8Array,
  key: Uint8Array,
  associatedData?: string
): { ciphertext: Uint8Array; nonce: Uint8Array } => {
  if (key.length !== XCHACHA20_PARAMS.KEY_LENGTH) {
    throw new Error(`Expected key length ${XCHACHA20_PARAMS.KEY_LENGTH}, got ${key.length}`)
  }

  const nonce = generateNonce()
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    associatedData ?? '',
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
  associatedData?: string
): Uint8Array => {
  if (key.length !== XCHACHA20_PARAMS.KEY_LENGTH) {
    throw new Error(`Expected key length ${XCHACHA20_PARAMS.KEY_LENGTH}, got ${key.length}`)
  }
  if (nonce.length !== XCHACHA20_PARAMS.NONCE_LENGTH) {
    throw new Error(`Expected nonce length ${XCHACHA20_PARAMS.NONCE_LENGTH}, got ${nonce.length}`)
  }

  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    associatedData ?? '',
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
  return decrypt(wrappedKey, nonce, vaultKey)
}

export const generateSigningKeyPairFromSeed = async (seed: Uint8Array): Promise<SigningKeyPair> => {
  await sodium.ready

  const pair = sodium.crypto_sign_seed_keypair(seed)
  return { publicKey: pair.publicKey, secretKey: pair.privateKey }
}

export const generateDeviceSigningKeyPair = async (): Promise<{
  deviceId: string
  publicKey: Uint8Array
  secretKey: Uint8Array
}> => {
  await sodium.ready

  const pair = sodium.crypto_sign_keypair()
  const deviceId = deriveDeviceId(pair.publicKey)
  return { deviceId, publicKey: pair.publicKey, secretKey: pair.privateKey }
}

// Same derivation as desktop keys.ts: hex(generichash(16, publicKey)).
export const deriveDeviceId = (publicKey: Uint8Array): string => {
  return sodium.to_hex(sodium.crypto_generichash(16, publicKey, null))
}

export const signDetached = (message: Uint8Array, secretKey: Uint8Array): Uint8Array => {
  return sodium.crypto_sign_detached(message, secretKey)
}

export const verifyDetached = (
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean => {
  return sodium.crypto_sign_verify_detached(signature, message, publicKey)
}

export const computeAuthTag = (message: Uint8Array, key: Uint8Array): Uint8Array => {
  return sodium.crypto_auth(message, key)
}

export const verifyAuthTag = (tag: Uint8Array, message: Uint8Array, key: Uint8Array): boolean => {
  return sodium.crypto_auth_verify(tag, message, key)
}

export const genericHash = (
  length: number,
  message: Uint8Array,
  key?: Uint8Array | null
): Uint8Array => {
  return sodium.crypto_generichash(length, message, key ?? null)
}

// X25519 ECDH — exposed by our binding patch (T007).
export const scalarmultBase = (secretKey: Uint8Array): Uint8Array => {
  return sodium.crypto_scalarmult_base(secretKey)
}

export const scalarmult = (secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array => {
  return sodium.crypto_scalarmult(secretKey, publicKey)
}

export const toBase64 = (bytes: Uint8Array): string => {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
}

export const fromBase64 = (value: string): Uint8Array => {
  return sodium.from_base64(value, sodium.base64_variants.ORIGINAL)
}

export const toHex = (bytes: Uint8Array): string => {
  return sodium.to_hex(bytes)
}
