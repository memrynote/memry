/**
 * Canvas runtime context — database, vault id, vault path.
 *
 * Canvases are plain `.excalidraw` files in the vault, so the read/write path
 * deliberately touches NO key material: it must work for a local-only user, for
 * a user who just upgraded to a paid sync account (which replaces the master
 * key), and for a vault folder copied to another machine.
 *
 * The vault key survives here for exactly one caller: the one-way migration in
 * `canvas/reconcile.ts` that decrypts pre-file snapshots. It is resolved once
 * per process like agent bootstrap (main/agent/bootstrap.ts):
 * getOrInitializeLocalVaultKey consults the OS keychain, and under NODE_ENV=test
 * the keychain degrades to not-found (400ms timeout in crypto/keychain.ts) — so
 * only the first call in a process can initialize; every later call would throw
 * "verifier exists but master key is missing". A failed resolution is not cached
 * so a transient keychain error can retry.
 *
 * @module canvas/vault-key
 */

import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import { getOrInitializeLocalVaultKey, secureCleanup } from '../crypto'
import { requireDatabase, type DataDb } from '../database'
import { getCanvasVaultPath } from './vault-path'

let vaultKeyPromise: Promise<Uint8Array> | null = null

export interface CanvasContext {
  db: DataDb
  vaultId: string
  vaultPath: string
}

export function getCanvasContext(): CanvasContext {
  const db = requireDatabase()
  const vaultId = getOrCreateVaultUuid(db)
  const vaultPath = getCanvasVaultPath()
  if (!vaultPath) throw new Error('No vault is open')
  return { db, vaultId, vaultPath }
}

/**
 * LEGACY ONLY — the key that decrypts pre-file canvas snapshots. Never call
 * this on a read/write path: it can mint master-key material and it fails on a
 * vault whose key has moved on, which is precisely what file-backed canvases
 * exist to survive.
 */
export function getLegacyCanvasVaultKey(db: DataDb, vaultId: string): Promise<Uint8Array> {
  if (!vaultKeyPromise) {
    vaultKeyPromise = getOrInitializeLocalVaultKey(db, vaultId).catch((error: unknown) => {
      vaultKeyPromise = null
      throw error
    })
  }
  return vaultKeyPromise
}

export function disposeCanvasVaultKey(): void {
  if (!vaultKeyPromise) return
  void vaultKeyPromise.then((key) => secureCleanup(key)).catch(() => {})
  vaultKeyPromise = null
}
