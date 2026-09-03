import { and, eq, isNull } from 'drizzle-orm'
import sodium from 'libsodium-wrappers-sumo'

import * as schema from '@memry/db-schema/data-schema'
import { KEYCHAIN_ENTRIES, KEY_DERIVATION_CONTEXTS } from '@memry/contracts/crypto'

import type { DataDb } from '../database/types'
import { confirmMasterKeyMigrated, retrieveKey, storeKey } from './keychain'
import { checkAccountKey } from './vault-key-policy'
import { deriveKey } from './keys'
import { lockKeyMaterial } from './memory-lock'
import { secureCleanup } from './primitives'

export const VAULT_KEY_VERIFIER_SETTING = 'vault.crypto.verifier.v1'

const VERIFIER_CONTEXT = 'memry/vault-key-verifier/v1'

export function computeVaultKeyVerifier(vaultKey: Uint8Array, vaultId: string): string {
  const input = new TextEncoder().encode(`${VERIFIER_CONTEXT}/${vaultId}`)
  const verifier = sodium.crypto_generichash(32, input, vaultKey)
  try {
    return sodium.to_base64(verifier, sodium.base64_variants.ORIGINAL)
  } finally {
    sodium.memzero(verifier)
  }
}

export function storeVaultKeyVerifier(db: DataDb, vaultId: string, vaultKey: Uint8Array): void {
  setVaultKeyVerifier(db, computeVaultKeyVerifier(vaultKey, vaultId))
}

export async function bindLocalVaultToMasterKey(
  db: DataDb,
  vaultId: string,
  masterKey: Uint8Array
): Promise<void> {
  await sodium.ready

  const vaultKey = await deriveKey(masterKey, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)
  lockKeyMaterial(vaultKey)
  try {
    const current = getVaultKeyVerifier(db)
    const next = computeVaultKeyVerifier(vaultKey, vaultId)
    if (current === next) return

    resetLegacyUnboundAgentData(db, vaultId)
    setVaultKeyVerifier(db, next)
    if (current !== null) {
      // The vault key just CHANGED (e.g. recovery restored the correct master
      // key after a mismatch window). Anything the old key's failures branded
      // is now meaningless: quarantined items would be skipped forever and a
      // stale cursor would miss items that failed to apply. Give the new key a
      // clean slate and let the next sync re-pull from scratch.
      purgeKeyScopedSyncState(db)
    }
  } finally {
    secureCleanup(vaultKey)
  }
}

// Mirrors SYNC_STATE_KEYS in sync/engine/sync-context.ts (imported as literals
// here to keep crypto/ free of sync-engine imports).
const KEY_SCOPED_SYNC_STATE_KEYS = [
  'lastCursor',
  'quarantinedItems',
  'lastManifestCheckAt'
] as const

function purgeKeyScopedSyncState(db: DataDb): void {
  for (const key of KEY_SCOPED_SYNC_STATE_KEYS) {
    db.delete(schema.syncState).where(eq(schema.syncState.key, key)).run()
  }
}

export async function getOrInitializeLocalVaultKey(
  db: DataDb,
  vaultId: string
): Promise<Uint8Array> {
  await sodium.ready

  const expectedVerifier = getVaultKeyVerifier(db)
  let masterKey = await retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)
  if (!masterKey) {
    if (await hasSyncCredentials()) {
      throw new Error(
        'Master key not found in keychain — cannot create a local vault key while sync credentials exist'
      )
    }
    if (expectedVerifier) {
      throw new Error('Vault key verifier exists but master key is missing')
    }
    resetLegacyUnboundAgentData(db, vaultId)

    masterKey = sodium.randombytes_buf(32)
    lockKeyMaterial(masterKey)
    try {
      await storeKey(KEYCHAIN_ENTRIES.MASTER_KEY, masterKey)
    } catch (error) {
      secureCleanup(masterKey)
      throw error
    }
  }

  try {
    const vaultKey = await deriveKey(masterKey, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)
    lockKeyMaterial(vaultKey)
    let keepVaultKey = false
    try {
      const outcome = await bindOrVerifyVaultKey(db, vaultId, vaultKey, expectedVerifier)
      keepVaultKey = true
      // The master key just passed the vault verifier check — safe to finish
      // its safeStorage migration by dropping the OS keychain copy. A rebind is
      // not a pass: the key only "opens" the vault because we just rewrote the
      // verifier to match it, so the OS keychain copy has to survive.
      if (outcome !== 'rebound') {
        await confirmMasterKeyMigrated()
      }
      return vaultKey
    } finally {
      if (!keepVaultKey) secureCleanup(vaultKey)
    }
  } finally {
    secureCleanup(masterKey)
  }
}

type BindOutcome = 'verified' | 'bound' | 'rebound'

async function bindOrVerifyVaultKey(
  db: DataDb,
  vaultId: string,
  vaultKey: Uint8Array,
  expected: string | null
): Promise<BindOutcome> {
  const actual = computeVaultKeyVerifier(vaultKey, vaultId)

  if (!expected) {
    bindVaultKey(db, vaultId, actual)
    return 'bound'
  }

  if (expected === actual) return 'verified'

  if (await mismatchIsRecoverable()) {
    throw new Error('Current master key does not match this vault')
  }

  // Unrecoverable by definition: either the device has no account (so no
  // recovery phrase exists to re-derive the key that sealed these rows), or the
  // account already confirmed this key is the right one and it is the vault's
  // verifier that travelled in stale from another machine. Rebinding costs the
  // key-scoped agent rows; refusing costs the user the whole feature plus every
  // other vault they moved. See vault-key-policy.ts.
  bindVaultKey(db, vaultId, actual)
  return 'rebound'
}

/**
 * Can the user get the original key back? Only then is failing loudly the kind
 * thing to do — it routes them to the recovery dialog instead of dropping data
 * they could have restored. `transition` and `unknown` count as recoverable:
 * never rebind on an uncertain read.
 */
async function mismatchIsRecoverable(): Promise<boolean> {
  if (!(await hasSyncCredentials())) return false
  return (await checkAccountKey()) !== 'match'
}

function bindVaultKey(db: DataDb, vaultId: string, verifier: string): void {
  resetLegacyUnboundAgentData(db, vaultId)
  setVaultKeyVerifier(db, verifier)
}

function resetLegacyUnboundAgentData(db: DataDb, vaultId: string): void {
  if (!hasEncryptedAgentData(db, vaultId)) return

  db.delete(schema.agentMessages).run()
  db.delete(schema.agentConversations).where(eq(schema.agentConversations.vaultId, vaultId)).run()
}

function getVaultKeyVerifier(db: DataDb): string | null {
  const row = db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, VAULT_KEY_VERIFIER_SETTING))
    .get()
  return row?.value ?? null
}

function setVaultKeyVerifier(db: DataDb, value: string): void {
  db.insert(schema.settings)
    .values({ key: VAULT_KEY_VERIFIER_SETTING, value })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value }
    })
    .run()
}

function hasEncryptedAgentData(db: DataDb, vaultId: string): boolean {
  const conversation = db
    .select({ id: schema.agentConversations.id })
    .from(schema.agentConversations)
    .where(
      and(
        eq(schema.agentConversations.vaultId, vaultId),
        isNull(schema.agentConversations.deletedAt)
      )
    )
    .limit(1)
    .get()
  if (conversation) return true

  const message = db
    .select({ id: schema.agentMessages.id })
    .from(schema.agentMessages)
    .where(isNull(schema.agentMessages.deletedAt))
    .limit(1)
    .get()
  return Boolean(message)
}

async function hasSyncCredentials(): Promise<boolean> {
  const refreshToken = await retrieveKey(KEYCHAIN_ENTRIES.REFRESH_TOKEN)
  const signingKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)

  try {
    return refreshToken !== null || signingKey !== null
  } finally {
    if (refreshToken) sodium.memzero(refreshToken)
    if (signingKey) sodium.memzero(signingKey)
  }
}
