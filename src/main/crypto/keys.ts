import sodium from 'libsodium-wrappers-sumo'

import {
  ARGON2_PARAMS,
  KEY_DERIVATION_CONTEXTS,
  KEYCHAIN_ENTRIES,
  LINKING_HKDF_CONTEXTS,
  X25519_PARAMS,
  type DeviceSigningKeyPair,
  type EphemeralKeyPair,
  type MasterKeyMaterial
} from '@shared/contracts/crypto'
import { CBOR_FIELD_ORDER } from '@shared/contracts/cbor-ordering'

import { encodeCbor } from './cbor'
import { retrieveKey } from './keychain'
import { lockKeyMaterial, unlockKeyMaterial } from './memory-lock'

const KDF_CONTEXT_MAP: Record<string, { ctx: string; id: number }> = {
  'memry-vault-key-v1': { ctx: 'memryvlt', id: 1 },
  'memry-signing-key-v1': { ctx: 'memrysgn', id: 2 },
  'memry-verify-key-v1': { ctx: 'memryvrf', id: 3 },
  'memry-key-verifier-v1': { ctx: 'memrykve', id: 4 },
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

  lockKeyMaterial(masterKey)

  try {
    const keyVerifier = await generateKeyVerifier(masterKey)

    return {
      masterKey,
      kdfSalt: sodium.to_base64(salt, sodium.base64_variants.ORIGINAL),
      keyVerifier
    }
  } catch (error) {
    unlockKeyMaterial(masterKey)
    sodium.memzero(masterKey)
    throw error
  }
}

export { generateFileKey } from './primitives'

export const generateDeviceSigningKeyPair = async (): Promise<DeviceSigningKeyPair> => {
  await sodium.ready

  const keyPair = sodium.crypto_sign_keypair()
  const deviceId = sodium.to_hex(sodium.crypto_generichash(16, keyPair.publicKey, null))

  const secretKey = new Uint8Array(keyPair.privateKey)
  sodium.memzero(keyPair.privateKey)

  return {
    deviceId,
    publicKey: keyPair.publicKey,
    secretKey
  }
}

export const getDevicePublicKey = (secretKey: Uint8Array): Uint8Array => {
  return sodium.crypto_sign_ed25519_sk_to_pk(secretKey)
}

export const getOrCreateSigningKeyPair = async (): Promise<DeviceSigningKeyPair> => {
  await sodium.ready

  const existing = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
  if (existing) {
    const publicKey = sodium.crypto_sign_ed25519_sk_to_pk(existing)
    const deviceId = sodium.to_hex(sodium.crypto_generichash(16, publicKey, null))
    return { deviceId, publicKey, secretKey: existing }
  }

  return generateDeviceSigningKeyPair()
}

export const generateKeyVerifier = async (masterKey: Uint8Array): Promise<string> => {
  const verifierKey = await deriveKey(masterKey, 'memry-key-verifier-v1', 32)
  try {
    return sodium.to_base64(verifierKey, sodium.base64_variants.ORIGINAL)
  } finally {
    sodium.memzero(verifierKey)
  }
}

export const generateSalt = (): Uint8Array => {
  return sodium.randombytes_buf(ARGON2_PARAMS.SALT_LENGTH)
}

export const getOrDeriveVaultKey = async (): Promise<Uint8Array> => {
  const masterKey = await retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)
  if (!masterKey) {
    throw new Error('Master key not found in keychain — cannot derive vault key')
  }

  try {
    const vaultKey = await deriveKey(masterKey, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)
    lockKeyMaterial(vaultKey)
    return vaultKey
  } finally {
    unlockKeyMaterial(masterKey)
    sodium.memzero(masterKey)
  }
}

// ============================================================================
// X25519 ECDH — Device Linking
// ============================================================================

export const generateX25519KeyPair = async (): Promise<EphemeralKeyPair> => {
  await sodium.ready
  const keyPair = sodium.crypto_box_keypair()
  return { publicKey: keyPair.publicKey, secretKey: keyPair.privateKey }
}

export const computeSharedSecret = async (
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array
): Promise<Uint8Array> => {
  await sodium.ready

  if (myPrivateKey.length !== X25519_PARAMS.SECRET_KEY_LENGTH) {
    throw new Error(`X25519 private key must be ${X25519_PARAMS.SECRET_KEY_LENGTH} bytes`)
  }
  if (theirPublicKey.length !== X25519_PARAMS.PUBLIC_KEY_LENGTH) {
    throw new Error(`X25519 public key must be ${X25519_PARAMS.PUBLIC_KEY_LENGTH} bytes`)
  }

  return sodium.crypto_scalarmult(myPrivateKey, theirPublicKey)
}

export const deriveLinkingKeys = async (
  sharedSecret: Uint8Array
): Promise<{ encKey: Uint8Array; macKey: Uint8Array }> => {
  const encKey = await deriveKey(sharedSecret, LINKING_HKDF_CONTEXTS.ENCRYPTION, 32)
  const macKey = await deriveKey(sharedSecret, LINKING_HKDF_CONTEXTS.MAC, 32)
  return { encKey, macKey }
}

export const computeVerificationCode = async (sharedSecret: Uint8Array): Promise<string> => {
  await sodium.ready

  const sasKey = await deriveKey(sharedSecret, LINKING_HKDF_CONTEXTS.SAS, 32)
  const hash = sodium.crypto_generichash(4, sasKey, null)
  sodium.memzero(sasKey)

  const uint32 = (hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]
  const code = (uint32 >>> 0) % 1000000
  return code.toString().padStart(6, '0')
}

// ============================================================================
// HMAC Proofs — Canonical CBOR → keyed MAC
// ============================================================================

export const computeLinkingProof = (
  macKey: Uint8Array,
  sessionId: string,
  devicePublicKey: string
): Uint8Array => {
  const payload = encodeCbor({ sessionId, devicePublicKey }, CBOR_FIELD_ORDER.LINKING_PROOF)
  return sodium.crypto_auth(payload, macKey)
}

export const computeKeyConfirm = (
  macKey: Uint8Array,
  sessionId: string,
  encryptedMasterKey: string
): Uint8Array => {
  const payload = encodeCbor({ sessionId, encryptedMasterKey }, CBOR_FIELD_ORDER.KEY_CONFIRM)
  return sodium.crypto_auth(payload, macKey)
}
