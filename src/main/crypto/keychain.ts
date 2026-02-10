import keytar from 'keytar'
import sodium from 'libsodium-wrappers-sumo'

import type { KeychainEntry } from '@shared/contracts/crypto'

export const storeKey = async (entry: KeychainEntry, key: Uint8Array): Promise<void> => {
  await sodium.ready
  const encoded = sodium.to_base64(key, sodium.base64_variants.ORIGINAL)
  try {
    await keytar.setPassword(entry.service, entry.account, encoded)
  } catch (err) {
    throw new Error(
      `Failed to store key in keychain (${entry.account}): ${err instanceof Error ? err.message : 'unknown error'}`
    )
  }
}

export const retrieveKey = async (entry: KeychainEntry): Promise<Uint8Array | null> => {
  await sodium.ready
  let encoded: string | null
  try {
    encoded = await keytar.getPassword(entry.service, entry.account)
  } catch (err) {
    throw new Error(
      `Failed to retrieve key from keychain (${entry.account}): ${err instanceof Error ? err.message : 'unknown error'}`
    )
  }

  if (!encoded) {
    return null
  }

  return sodium.from_base64(encoded, sodium.base64_variants.ORIGINAL)
}

export const deleteKey = async (entry: KeychainEntry): Promise<void> => {
  try {
    await keytar.deletePassword(entry.service, entry.account)
  } catch (err) {
    throw new Error(
      `Failed to delete key from keychain (${entry.account}): ${err instanceof Error ? err.message : 'unknown error'}`
    )
  }
}
