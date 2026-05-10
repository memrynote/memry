import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import { getOrCreateVaultUuid } from '../vault-id'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE vault_metadata (
      id TEXT PRIMARY KEY,
      vault_uuid TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return drizzle(sqlite, { schema })
}

describe('getOrCreateVaultUuid', () => {
  let db: ReturnType<typeof freshDb>

  beforeEach(() => {
    db = freshDb()
  })

  it('creates a UUID on first call', () => {
    const uuid = getOrCreateVaultUuid(db)
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('returns the same UUID on subsequent calls', () => {
    const a = getOrCreateVaultUuid(db)
    const b = getOrCreateVaultUuid(db)
    const c = getOrCreateVaultUuid(db)
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('only writes one row', () => {
    getOrCreateVaultUuid(db)
    getOrCreateVaultUuid(db)
    const rows = db.select().from(schema.vaultMetadata).all()
    expect(rows).toHaveLength(1)
  })
})
