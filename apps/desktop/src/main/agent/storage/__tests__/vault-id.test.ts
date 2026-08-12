import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import { getOrCreateVaultUuid, resetVaultUuidCache } from '../vault-id'

function freshSqlite() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE vault_metadata (
      id TEXT PRIMARY KEY,
      vault_uuid TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return sqlite
}

function freshDb() {
  return drizzle(freshSqlite(), { schema })
}

/** Rewrite the singleton behind drizzle's back, the way adoptVaultLocally does. */
function rewriteUuid(sqlite: Database.Database, uuid: string): void {
  sqlite.prepare(`UPDATE vault_metadata SET vault_uuid = ? WHERE id = 'singleton'`).run(uuid)
}

describe('getOrCreateVaultUuid', () => {
  let db: ReturnType<typeof freshDb>

  beforeEach(() => {
    // Module-level cache, so leaking one test's handle into the next would
    // mask exactly the staleness these tests exist to pin.
    resetVaultUuidCache()
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

  it('reads the singleton row once per handle instead of on every call', () => {
    // #given a handle whose SELECTs are counted at the SQLite layer, so this
    // measures real query execution rather than a mocked drizzle
    const sqlite = freshSqlite()
    let selects = 0
    const counting = new Proxy(sqlite, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (prop !== 'prepare') return typeof value === 'function' ? value.bind(target) : value
        return (source: string) => {
          if (/^\s*select/i.test(source)) selects++
          return target.prepare(source)
        }
      }
    }) as Database.Database
    const countedDb = drizzle(counting, { schema })

    // #when the same vault identity is resolved from several call sites
    getOrCreateVaultUuid(countedDb)
    const selectsAfterFirst = selects
    for (let i = 0; i < 10; i++) getOrCreateVaultUuid(countedDb)

    // #then only the first call touched the database
    expect(selects).toBe(selectsAfterFirst)
  })

  it('serves an existing row from cache after the first read', () => {
    const sqlite = freshSqlite()
    sqlite
      .prepare(
        `INSERT INTO vault_metadata (id, vault_uuid, created_at, updated_at)
         VALUES ('singleton', 'pre-existing', 0, 0)`
      )
      .run()
    const existingDb = drizzle(sqlite, { schema })

    expect(getOrCreateVaultUuid(existingDb)).toBe('pre-existing')
    // Rewritten with no invalidation → the cached value is what comes back,
    // which is the property every explicit reset call site depends on.
    rewriteUuid(sqlite, 'rewritten')
    expect(getOrCreateVaultUuid(existingDb)).toBe('pre-existing')
  })

  it('re-reads after resetVaultUuidCache, so an in-place adoption is observed', () => {
    const sqlite = freshSqlite()
    const adoptedDb = drizzle(sqlite, { schema })
    const own = getOrCreateVaultUuid(adoptedDb)

    rewriteUuid(sqlite, 'initiator-uuid')
    resetVaultUuidCache()

    expect(getOrCreateVaultUuid(adoptedDb)).toBe('initiator-uuid')
    expect(getOrCreateVaultUuid(adoptedDb)).not.toBe(own)
  })

  it('never serves one vault handle the identity of another', () => {
    // #given two open vaults — a vault switch installs a new drizzle instance
    const first = freshSqlite()
    const second = freshSqlite()
    const firstDb = drizzle(first, { schema })
    const secondDb = drizzle(second, { schema })

    // #when each mints its own identity
    const firstUuid = getOrCreateVaultUuid(firstDb)
    const secondUuid = getOrCreateVaultUuid(secondDb)

    // #then the cache keys on the handle, so neither is confused for the other
    expect(secondUuid).not.toBe(firstUuid)
    expect(getOrCreateVaultUuid(firstDb)).toBe(firstUuid)
    expect(getOrCreateVaultUuid(secondDb)).toBe(secondUuid)
  })
})
