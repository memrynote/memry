import sodium from 'libsodium-wrappers-sumo'

import {
  ARGON2_PARAMS,
  LINKING_HKDF_CONTEXTS,
  type DeviceSigningKeyPair,
  type MasterKeyMaterial
} from '@shared/contracts/crypto'

const KDF_CONTEXT_MAP: Record<string, { ctx: string; id: number }> = {
  'memry-vault-key-v1': { ctx: 'memryvlt', id: 1 },
  'memry-signing-key-v1': { ctx: 'memrysgn', id: 2 },
  'memry-verify-key-v1': { ctx: 'memryvrf', id: 3 },
  'memry-key-verifier-v1': { ctx: 'memrykve', id: 4 },
  [LINKING_HKDF_CONTEXTS.ENCRYPTION]: { ctx: 'memrylnk', id: 5 },
  [LINKING_HKDF_CONTEXTS.MAC]: { ctx: 'memrymac', id: 6 }
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

  try {
    const keyVerifier = await generateKeyVerifier(masterKey)

    return {
      masterKey,
      kdfSalt: sodium.to_base64(salt, sodium.base64_variants.ORIGINAL),
      keyVerifier
    }
  } catch (error) {
    sodium.memzero(masterKey)
    throw error
  }
}

export const generateFileKey = (): Uint8Array => {
  return sodium.randombytes_buf(32)
}

export const generateDeviceSigningKeyPair = async (): Promise<DeviceSigningKeyPair> => {
  await sodium.ready

  const keyPair = sodium.crypto_sign_keypair()
  const deviceId = sodium.to_hex(sodium.crypto_generichash(16, keyPair.publicKey, null))

  return {
    deviceId,
    publicKey: keyPair.publicKey,
    secretKey: keyPair.privateKey
  }
}

export const getDevicePublicKey = (secretKey: Uint8Array): Uint8Array => {
  return sodium.crypto_sign_ed25519_sk_to_pk(secretKey)
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
