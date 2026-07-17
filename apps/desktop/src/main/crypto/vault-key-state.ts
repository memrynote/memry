import { and, eq, isNull } from 'drizzle-orm'
import sodium from 'libsodium-wrappers-sumo'

import * as schema from '@memry/db-schema/data-schema'
import { KEYCHAIN_ENTRIES, KEY_DERIVATION_CONTEXTS } from '@memry/contracts/crypto'

import type { DataDb } from '../database/types'
import { confirmMasterKeyMigrated, retrieveKey, storeKey } from './keychain'
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
  } finally {
    secureCleanup(vaultKey)
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
      bindOrVerifyVaultKey(db, vaultId, vaultKey, expectedVerifier)
      keepVaultKey = true
      // The master key just passed the vault verifier check — safe to finish
      // its safeStorage migration by dropping the OS keychain copy.
      await confirmMasterKeyMigrated()
      return vaultKey
    } finally {
      if (!keepVaultKey) secureCleanup(vaultKey)
    }
  } finally {
    secureCleanup(masterKey)
  }
}

function bindOrVerifyVaultKey(
  db: DataDb,
  vaultId: string,
  vaultKey: Uint8Array,
  expected: string | null
): void {
  const actual = computeVaultKeyVerifier(vaultKey, vaultId)

  if (!expected) {
    resetLegacyUnboundAgentData(db, vaultId)
    setVaultKeyVerifier(db, actual)
    return
  }

  if (expected !== actual) {
    throw new Error('Current master key does not match this vault')
  }
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
