import sodium from 'libsodium-wrappers-sumo'

import { decrypt, encrypt } from '../crypto'

const NAME_AAD_PREFIX = 'vault-name-v1'

const aadFor = (vaultUuid: string): Uint8Array =>
  new TextEncoder().encode(`${NAME_AAD_PREFIX}:${vaultUuid}`)

const toB64 = (input: Uint8Array): string =>
  sodium.to_base64(input, sodium.base64_variants.ORIGINAL)

const fromB64 = (input: string): Uint8Array =>
  sodium.from_base64(input, sodium.base64_variants.ORIGINAL)

export function encryptVaultName(
  name: string,
  key: Uint8Array,
  vaultUuid: string
): { encryptedName: string; nameNonce: string } {
  const { ciphertext, nonce } = encrypt(new TextEncoder().encode(name), key, aadFor(vaultUuid))
  return { encryptedName: toB64(ciphertext), nameNonce: toB64(nonce) }
}

export function decryptVaultName(
  encryptedName: string,
  nameNonce: string,
  key: Uint8Array,
  vaultUuid: string
): string | null {
  try {
    const plaintext = decrypt(fromB64(encryptedName), fromB64(nameNonce), key, aadFor(vaultUuid))
    return new TextDecoder().decode(plaintext)
  } catch {
    return null
  }
}
