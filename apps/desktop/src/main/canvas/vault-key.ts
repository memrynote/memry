/**
 * The one cached vault-key accessor for canvas code.
 *
 * Resolved once per process, like agent bootstrap (main/agent/bootstrap.ts):
 * getOrInitializeLocalVaultKey consults the OS keychain, and under
 * NODE_ENV=test the keychain degrades to not-found (400ms timeout in
 * crypto/keychain.ts) — so only the first call in a process can initialize;
 * every later call would throw "verifier exists but master key is missing".
 * A failed resolution is not cached so a transient keychain error can retry.
 *
 * Lives here rather than in ipc/canvas-handlers.ts because the agent MCP
 * canvas tools need the same key, and a second initializer in the process is
 * exactly the failure above.
 *
 * @module canvas/vault-key
 */

import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import { getOrInitializeLocalVaultKey, secureCleanup } from '../crypto'
import { requireDatabase, type DataDb } from '../database'

let vaultKeyPromise: Promise<Uint8Array> | null = null

function getVaultKeyOnce(db: DataDb, vaultId: string): Promise<Uint8Array> {
  if (!vaultKeyPromise) {
    vaultKeyPromise = getOrInitializeLocalVaultKey(db, vaultId).catch((error: unknown) => {
      vaultKeyPromise = null
      throw error
    })
  }
  return vaultKeyPromise
}

export async function getCanvasContext(): Promise<{
  db: DataDb
  vaultId: string
  vaultKey: Uint8Array
}> {
  const db = requireDatabase()
  const vaultId = getOrCreateVaultUuid(db)
  const vaultKey = await getVaultKeyOnce(db, vaultId)
  return { db, vaultId, vaultKey }
}

export function disposeCanvasVaultKey(): void {
  if (!vaultKeyPromise) return
  void vaultKeyPromise.then((key) => secureCleanup(key)).catch(() => {})
  vaultKeyPromise = null
}
