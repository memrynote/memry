import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'

const SINGLETON_ID = 'singleton'

type VaultUuidDb = BetterSQLite3Database<typeof schema>

// vault_metadata holds a single row keyed on the literal 'singleton', and its
// uuid never changes for as long as a vault stays open — yet every one of the
// eleven call sites (sync runtime, canvas reconcile, crypto handlers, per
// attachment, device registration, the HTTP request header) rebuilt a drizzle
// query and re-read it. Cache it against the DataDb instance the caller passes:
// opening, closing or switching a vault installs a brand-new drizzle instance
// (see database/client.ts initDatabase), so the key misses on its own and no
// vault switch can be served the previous vault's identity — which would be a
// correctness bug in sync and crypto, not a perf one. WeakMap so a closed
// vault's entry dies with its handle.
//
// The one rewrite that keeps the *same* handle — a linked device adopting the
// initiator's uuid (sync/vault-adoption.ts, and the E2E bootstrapSyncDevice
// hook) — must call resetVaultUuidCache() explicitly.
let vaultUuidCache = new WeakMap<VaultUuidDb, string>()

/** Invalidate after an in-place rewrite of the vault_metadata singleton. */
export function resetVaultUuidCache(): void {
  // Whole-map reset rather than a per-handle delete: an adoption can run
  // against a handle the caller resolved separately, and dropping every entry
  // is always safe (the next call re-reads one indexed row).
  vaultUuidCache = new WeakMap()
}

export function getOrCreateVaultUuid(db: VaultUuidDb): string {
  const cached = vaultUuidCache.get(db)
  if (cached !== undefined) return cached

  const existing = db
    .select()
    .from(schema.vaultMetadata)
    .where(eq(schema.vaultMetadata.id, SINGLETON_ID))
    .get()

  if (existing) {
    vaultUuidCache.set(db, existing.vaultUuid)
    return existing.vaultUuid
  }

  const uuid = randomUUID()
  const now = Date.now()
  db.insert(schema.vaultMetadata)
    .values({ id: SINGLETON_ID, vaultUuid: uuid, createdAt: now, updatedAt: now })
    .run()
  vaultUuidCache.set(db, uuid)
  return uuid
}
