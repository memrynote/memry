import keytar from 'keytar'
import sodium from 'libsodium-wrappers-sumo'

import type { KeychainEntry } from '@memry/contracts/crypto'

function resolveAccount(entry: KeychainEntry): string {
  const deviceSuffix = process.env.MEMRY_DEVICE
  return deviceSuffix ? `${entry.account}-${deviceSuffix}` : entry.account
}

// Accepted risk: keytar stores strings, so keys are base64-encoded in OS keychain memory.
// The base64 copy is an inherent JS/keytar limitation — no way to securely zero a JS string.
// Mitigated by: OS keychain encryption at rest, short-lived Uint8Array on retrieval.
export const storeKey = async (entry: KeychainEntry, key: Uint8Array): Promise<void> => {
  await sodium.ready
  const encoded = sodium.to_base64(key, sodium.base64_variants.ORIGINAL)
  const account = resolveAccount(entry)
  try {
    await keytar.setPassword(entry.service, account, encoded)
  } catch (err) {
    throw new Error(
      `Failed to store key in keychain (${account}): ${err instanceof Error ? err.message : 'unknown error'}`
    )
  }
}

export const retrieveKey = async (entry: KeychainEntry): Promise<Uint8Array | null> => {
  await sodium.ready
  const account = resolveAccount(entry)
  let encoded: string | null
  try {
    encoded = await keytar.getPassword(entry.service, account)
  } catch (err) {
    throw new Error(
      `Failed to retrieve key from keychain (${account}): ${err instanceof Error ? err.message : 'unknown error'}`
    )
  }

  if (!encoded) {
    return null
  }

  return sodium.from_base64(encoded, sodium.base64_variants.ORIGINAL)
}

export const deleteKey = async (entry: KeychainEntry): Promise<void> => {
  const account = resolveAccount(entry)
  try {
    await keytar.deletePassword(entry.service, account)
  } catch (err) {
    throw new Error(
      `Failed to delete key from keychain (${account}): ${err instanceof Error ? err.message : 'unknown error'}`
    )
  }
}
