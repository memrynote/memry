import keytar from 'keytar'
import sodium from 'libsodium-wrappers-sumo'

import type { KeychainEntry } from '@shared/contracts/crypto'

export const storeKey = async (entry: KeychainEntry, key: Uint8Array): Promise<void> => {
  await sodium.ready
  const encoded = sodium.to_base64(key, sodium.base64_variants.ORIGINAL)
  await keytar.setPassword(entry.service, entry.account, encoded)
}

export const retrieveKey = async (entry: KeychainEntry): Promise<Uint8Array | null> => {
  await sodium.ready
  const encoded = await keytar.getPassword(entry.service, entry.account)

  if (!encoded) {
    return null
  }

  return sodium.from_base64(encoded, sodium.base64_variants.ORIGINAL)
}

export const deleteKey = async (entry: KeychainEntry): Promise<void> => {
  await keytar.deletePassword(entry.service, entry.account)
}
