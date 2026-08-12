import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import { VAULT_KEY_VERIFIER_SETTING } from '../crypto/vault-key-state'
import { adoptVaultLocally } from './vault-adoption'

function createTestDataDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      modified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE vault_metadata (
      id TEXT PRIMARY KEY,
      vault_uuid TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return drizzle(sqlite, { schema })
}

const INITIATOR_UUID = '8945f5fd-0e05-45f5-bae5-2979737aa0d0'

describe('adoptVaultLocally', () => {
  let db: ReturnType<typeof createTestDataDb>

  beforeEach(() => {
    db = createTestDataDb()
  })

  it('binds the joiner to the initiator vault uuid instead of a fresh one', () => {
    // Joiner opened a fresh local vault first → its own random uuid + a stale
    // verifier. This first call also primes the handle-keyed cache inside
    // getOrCreateVaultUuid — keep it: without adoptVaultLocally's explicit
    // invalidation, every later call site would still read the joiner's own id
    // and register the device against the wrong vault.
    const joinerOwnUuid = getOrCreateVaultUuid(db)
    db.insert(schema.settings)
      .values({ key: VAULT_KEY_VERIFIER_SETTING, value: 'stale-verifier' })
      .run()
    expect(joinerOwnUuid).not.toBe(INITIATOR_UUID)

    adoptVaultLocally(db, INITIATOR_UUID)

    // vault_metadata now holds the initiator's uuid → registration will send V.
    expect(getOrCreateVaultUuid(db)).toBe(INITIATOR_UUID)
    // and it stays adopted once re-cached, rather than flapping per call.
    expect(getOrCreateVaultUuid(db)).toBe(INITIATOR_UUID)
    // stale verifier cleared so bindLocalVaultToMasterKey can rebind cleanly.
    const verifier = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, VAULT_KEY_VERIFIER_SETTING))
      .get()
    expect(verifier).toBeUndefined()
  })
})
