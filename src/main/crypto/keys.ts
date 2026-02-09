import sodium from 'libsodium-wrappers-sumo'

import {
  ARGON2_PARAMS,
  type DeviceSigningKeyPair,
  type MasterKeyMaterial
} from '@shared/contracts/crypto'

export const deriveKey = async (
  masterKey: Uint8Array,
  context: string,
  length: number
): Promise<Uint8Array> => {
  await sodium.ready
  return sodium.crypto_generichash(length, sodium.from_string(context), masterKey)
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

  const keyVerifier = generateKeyVerifier(masterKey)

  return {
    masterKey,
    kdfSalt: sodium.to_base64(salt, sodium.base64_variants.ORIGINAL),
    keyVerifier
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

export const generateKeyVerifier = (masterKey: Uint8Array): string => {
  const hash = sodium.crypto_generichash(32, masterKey, null)
  return sodium.to_base64(hash, sodium.base64_variants.ORIGINAL)
}

export const generateSalt = (): Uint8Array => {
  return sodium.randombytes_buf(ARGON2_PARAMS.SALT_LENGTH)
}
