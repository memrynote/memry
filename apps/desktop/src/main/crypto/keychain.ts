import keytar from 'keytar'
import sodium from 'libsodium-wrappers-sumo'

import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import type { KeychainEntry } from '@memry/contracts/crypto'

import {
  deleteSecret,
  finalizeKeytarMigration,
  getSecret,
  setSecret
} from '../secrets/secret-storage'
import { normalizeDeviceSuffix, resolveKeychainAccount } from './keychain-account'

function resolveAccount(entry: KeychainEntry): string {
  return resolveKeychainAccount(entry, process.env.MEMRY_DEVICE)
}

// Plain-dev worktrees share one master key through the machine-global OS
// keychain (the per-worktree dev hash collapses to a stable `dev` account, see
// keychain-account.ts) while userData — and therefore the safeStorage store
// file — stays per-worktree. Migrating out of keytar there would strand the
// shared key for every other worktree, so plain `pnpm dev` keeps keytar
// authoritative. Production (no MEMRY_DEVICE) and explicit devices migrate.
function usesSharedDevKeychain(): boolean {
  return normalizeDeviceSuffix(process.env.MEMRY_DEVICE) === 'dev'
}

function isMasterKeyEntry(entry: KeychainEntry): boolean {
  return (
    entry.service === KEYCHAIN_ENTRIES.MASTER_KEY.service &&
    entry.account === KEYCHAIN_ENTRIES.MASTER_KEY.account
  )
}

// The OS keychain hangs under automated e2e (an adhoc-signed/headless build
// triggers an unanswerable macOS keychain prompt; a Linux CI box has no keyring
// daemon), which would leave the agent runtime stuck starting forever. Under
// NODE_ENV=test only, bound each keychain call so a hang degrades to the
// not-found path instead of blocking. In unit tests keytar is mocked and
// resolves instantly, so the timeout never fires there. The bound wraps the
// whole dual-read (safeStorage store first, keytar fallback), so the keytar
// fallback path stays covered.
const KEYCHAIN_TEST_TIMEOUT_MS = 400
const isTestEnv = process.env.NODE_ENV === 'test'

async function withTestTimeout<T>(op: Promise<T>, fallback: T): Promise<T> {
  if (!isTestEnv) return op
  let timer: ReturnType<typeof setTimeout>
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), KEYCHAIN_TEST_TIMEOUT_MS)
  })
  try {
    return await Promise.race([op, guard])
  } finally {
    clearTimeout(timer!)
  }
}

// Accepted risk: secrets are stored as strings, so keys are base64-encoded in
// memory during store/retrieve. The base64 copy is an inherent JS limitation —
// no way to securely zero a JS string. Mitigated by: encryption at rest
// (safeStorage or OS keychain), short-lived Uint8Array on retrieval.
export const storeKey = async (entry: KeychainEntry, key: Uint8Array): Promise<void> => {
  await sodium.ready
  const encoded = sodium.to_base64(key, sodium.base64_variants.ORIGINAL)
  const account = resolveAccount(entry)
  try {
    if (usesSharedDevKeychain()) {
      await withTestTimeout(keytar.setPassword(entry.service, account, encoded), undefined)
    } else {
      await withTestTimeout(setSecret(entry.service, account, encoded), undefined)
    }
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
    if (usesSharedDevKeychain()) {
      encoded = await withTestTimeout(keytar.getPassword(entry.service, account), null)
    } else {
      // The master key's OS keychain copy is only dropped after the retrieved
      // key has been confirmed against the vault verifier — see
      // confirmMasterKeyMigrated and crypto/vault-key-state.ts.
      encoded = await withTestTimeout(
        getSecret(entry.service, account, { deferKeytarDelete: isMasterKeyEntry(entry) }),
        null
      )
    }
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
    if (usesSharedDevKeychain()) {
      await keytar.deletePassword(entry.service, account)
    } else {
      await deleteSecret(entry.service, account)
    }
  } catch (err) {
    throw new Error(
      `Failed to delete key from keychain (${account}): ${err instanceof Error ? err.message : 'unknown error'}`
    )
  }
}

/**
 * Finish the master key's deferred safeStorage migration. Called once the
 * retrieved key has been confirmed against the vault verifier; only then is
 * the OS keychain copy deleted (and only while it is byte-identical to the
 * safeStorage copy). Idempotent, crash-resumable, never throws.
 */
export const confirmMasterKeyMigrated = async (): Promise<void> => {
  if (usesSharedDevKeychain()) return
  await finalizeKeytarMigration(
    KEYCHAIN_ENTRIES.MASTER_KEY.service,
    resolveAccount(KEYCHAIN_ENTRIES.MASTER_KEY)
  )
}
