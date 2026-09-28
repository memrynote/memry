import sodium from 'libsodium-wrappers-sumo'

import { decrypt, encrypt } from '../crypto'

const NAME_AAD_PREFIX = 'vault-name-v1'
const ICON_AAD_PREFIX = 'vault-icon-v1'

const aadFor = (prefix: string, vaultUuid: string): Uint8Array =>
  new TextEncoder().encode(`${prefix}:${vaultUuid}`)

const toB64 = (input: Uint8Array): string =>
  sodium.to_base64(input, sodium.base64_variants.ORIGINAL)

const fromB64 = (input: string): Uint8Array =>
  sodium.from_base64(input, sodium.base64_variants.ORIGINAL)

function seal(
  prefix: string,
  text: string,
  key: Uint8Array,
  vaultUuid: string
): { ciphertext: string; nonce: string } {
  const { ciphertext, nonce } = encrypt(
    new TextEncoder().encode(text),
    key,
    aadFor(prefix, vaultUuid)
  )
  return { ciphertext: toB64(ciphertext), nonce: toB64(nonce) }
}

function open(
  prefix: string,
  ciphertext: string,
  nonce: string,
  key: Uint8Array,
  vaultUuid: string
): string | null {
  try {
    const plaintext = decrypt(fromB64(ciphertext), fromB64(nonce), key, aadFor(prefix, vaultUuid))
    return new TextDecoder().decode(plaintext)
  } catch {
    return null
  }
}

export function encryptVaultName(
  name: string,
  key: Uint8Array,
  vaultUuid: string
): { encryptedName: string; nameNonce: string } {
  const { ciphertext, nonce } = seal(NAME_AAD_PREFIX, name, key, vaultUuid)
  return { encryptedName: ciphertext, nameNonce: nonce }
}

export function decryptVaultName(
  encryptedName: string,
  nameNonce: string,
  key: Uint8Array,
  vaultUuid: string
): string | null {
  return open(NAME_AAD_PREFIX, encryptedName, nameNonce, key, vaultUuid)
}

/**
 * A vault's icon, sealed like its name under its own AAD so an icon envelope
 * can never be replayed as a name or the other way round (protocol 04 §4.16).
 */
export function encryptVaultIcon(
  icon: string,
  key: Uint8Array,
  vaultUuid: string
): { encryptedIcon: string; iconNonce: string } {
  const { ciphertext, nonce } = seal(ICON_AAD_PREFIX, icon, key, vaultUuid)
  return { encryptedIcon: ciphertext, iconNonce: nonce }
}

/** Null on any failure, like `decryptVaultName`: a bad icon must not break the vault list. */
export function decryptVaultIcon(
  encryptedIcon: string,
  iconNonce: string,
  key: Uint8Array,
  vaultUuid: string
): string | null {
  return open(ICON_AAD_PREFIX, encryptedIcon, iconNonce, key, vaultUuid)
}
