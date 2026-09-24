import Database from 'better-sqlite3'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { resolveSyncSubscription } from '../lib/sync-types'
import { getUpdates, storeUpdates } from '../services/crdt'
import { getChanges } from '../services/sync'

/**
 * #2296: a retried CRDT update push must not store the update twice. The
 * server hashes the stored bytes; a second insert of the same bytes for the
 * same note is ignored and answers the sequence number the first one got.
 */

const USER_ID = 'user-idempotent'
const VAULT_ID = 'default'
const DEVICE_ID = 'device-idempotent'

let harness: SqliteD1

const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer

const storageUsed = (): number =>
  (
    harness.raw.prepare('SELECT storage_used FROM users WHERE id = ?').get(USER_ID) as {
      storage_used: number
    }
  ).storage_used

const rowCount = (noteId: string): number =>
  (
    harness.raw
      .prepare('SELECT COUNT(*) AS n FROM crdt_updates WHERE user_id = ? AND note_id = ?')
      .get(USER_ID, noteId) as { n: number }
  ).n

const store = (noteId: string, updates: ArrayBuffer[]): Promise<number[]> =>
  storeUpdates(harness.db, USER_ID, VAULT_ID, noteId, DEVICE_ID, updates)

beforeEach(() => {
  harness = createSqliteD1()
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, 0, 1, 1)`
    )
    .run(USER_ID, `${USER_ID}@example.com`)
  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, 1)`
    )
    .run(USER_ID, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024)
})

afterEach(() => {
  harness.close()
})

describe('storeUpdates is idempotent per note (#2296)', () => {
  it('stores a retried update once and answers the same sequences', async () => {
    const first = await store('note-1', [bytes(1, 2, 3)])
    const retry = await store('note-1', [bytes(1, 2, 3)])

    expect(first).toEqual([1])
    expect(retry).toEqual([1])
    expect(rowCount('note-1')).toBe(1)
  })

  it('charges storage once for a retried update', async () => {
    await store('note-1', [bytes(1, 2, 3)])
    await store('note-1', [bytes(1, 2, 3)])

    expect(storageUsed()).toBe(3)
  })

  it('stores the new updates of a partly retried batch after the existing ones', async () => {
    await store('note-1', [bytes(1), bytes(2)])
    const retry = await store('note-1', [bytes(1), bytes(2), bytes(3)])

    expect(retry).toEqual([1, 2, 3])
    expect(rowCount('note-1')).toBe(3)
    expect(storageUsed()).toBe(3)
    const pulled = await getUpdates(harness.db, USER_ID, VAULT_ID, 'note-1', 0)
    expect(pulled.updates.map((update) => update.sequence_num)).toEqual([1, 2, 3])
  })

  it('collapses the same bytes sent twice in one request', async () => {
    const sequences = await store('note-1', [bytes(9), bytes(9)])

    expect(sequences).toEqual([1, 1])
    expect(rowCount('note-1')).toBe(1)
    expect(storageUsed()).toBe(1)
  })

  it('scopes the hash to the note: the same bytes on another note are a new row', async () => {
    await store('note-1', [bytes(5)])
    const other = await store('note-2', [bytes(5)])

    expect(other).toEqual([1])
    expect(rowCount('note-2')).toBe(1)
  })

  it('never matches a pre-migration row, which has no hash', async () => {
    harness.raw
      .prepare(
        `INSERT INTO crdt_updates (id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at)
         VALUES ('legacy-u', ?, ?, 'note-1', x'07', 1, ?, 1)`
      )
      .run(USER_ID, VAULT_ID, DEVICE_ID)

    const sequences = await store('note-1', [bytes(7)])

    expect(sequences).toEqual([2])
    expect(rowCount('note-1')).toBe(2)
  })

  it('serves a retried update once in the change feed', async () => {
    await store('note-1', [bytes(4)])
    await store('note-1', [bytes(4)])

    const page = await getChanges(
      harness.db,
      USER_ID,
      0,
      undefined,
      VAULT_ID,
      resolveSyncSubscription('note_body')
    )

    expect(page.noteBodies?.map((body) => body.sequenceNum)).toEqual([1])
  })
})

// #2296: a retry of bytes the server already holds needs no new storage, so a
// full quota must not refuse it. Only the updates that will really be stored
// are reserved.
describe('storeUpdates quota on a retry (#2296)', () => {
  const setStorage = (used: number, limit: number): void => {
    harness.raw.prepare('UPDATE users SET storage_used = ? WHERE id = ?').run(used, USER_ID)
    harness.raw
      .prepare('UPDATE sync_entitlements SET storage_limit = ? WHERE user_id = ?')
      .run(limit, USER_ID)
  }

  it('answers a retry of stored bytes when the quota has filled up since', async () => {
    setStorage(0, 10)
    expect(await store('note-1', [bytes(1, 2, 3)])).toEqual([1])
    setStorage(10, 10)

    expect(await store('note-1', [bytes(1, 2, 3)])).toEqual([1])
    expect(storageUsed()).toBe(10)
    expect(rowCount('note-1')).toBe(1)
  })

  it('reserves only the new updates of a partly retried batch', async () => {
    setStorage(0, 10)
    await store('note-1', [bytes(1, 2, 3)])
    setStorage(8, 10)

    expect(await store('note-1', [bytes(1, 2, 3), bytes(4, 5)])).toEqual([1, 2])
    expect(storageUsed()).toBe(10)
  })

  it('reserves the same bytes sent twice in one request once', async () => {
    setStorage(8, 10)

    expect(await store('note-1', [bytes(6, 7), bytes(6, 7)])).toEqual([1, 1])
    expect(storageUsed()).toBe(10)
  })

  it('still refuses new bytes over the quota', async () => {
    setStorage(9, 10)

    await expect(store('note-1', [bytes(1, 2)])).rejects.toMatchObject({
      code: 'STORAGE_QUOTA_EXCEEDED'
    })
    expect(rowCount('note-1')).toBe(0)
  })

  it('refunds an update that became a duplicate between the lookup and the insert', async () => {
    setStorage(0, 100)
    const update = bytes(8, 8, 8)
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', update)), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('')
    // A concurrent request stores the same bytes after this one's lookup.
    const racing = {
      ...harness.db,
      batch: async (statements: D1PreparedStatement[]) => {
        harness.raw
          .prepare(
            `INSERT OR IGNORE INTO crdt_updates (id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at, update_hash)
             VALUES ('racer', ?, ?, 'note-1', x'080808', 1, ?, 1, ?)`
          )
          .run(USER_ID, VAULT_ID, DEVICE_ID, hash)
        return harness.db.batch(statements)
      }
    } as D1Database

    expect(await storeUpdates(racing, USER_ID, VAULT_ID, 'note-1', DEVICE_ID, [update])).toEqual([
      1
    ])
    expect(storageUsed()).toBe(0)
    expect(rowCount('note-1')).toBe(1)
  })
})

describe('migration 0012_crdt_update_hash (#2296)', () => {
  const migrationsDir = resolve(__dirname, '../../migrations')
  const MIGRATION = '0012_crdt_update_hash.sql'
  const files = (): string[] =>
    readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort()

  it('applies on a populated database without touching existing update rows', () => {
    const db = new Database(':memory:')
    try {
      for (const file of files().filter((name) => name < MIGRATION)) {
        db.exec(readFileSync(join(migrationsDir, file), 'utf8'))
      }
      db.prepare(
        `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
         VALUES ('user-1', 'u1@example.com', 1, 'otp', 0, 0, 1, 1)`
      ).run()
      const insert = db.prepare(
        `INSERT INTO crdt_updates (id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at, server_cursor)
         VALUES (?, 'user-1', 'default', 'note-1', ?, ?, 'device-1', 1, ?)`
      )
      // Two rows with the SAME bytes: the unique index must not reject them.
      insert.run('u-1', Buffer.from([1]), 1, null)
      insert.run('u-2', Buffer.from([1]), 2, 7)
      const before = db.prepare('SELECT * FROM crdt_updates ORDER BY id').all()

      db.exec(readFileSync(join(migrationsDir, MIGRATION), 'utf8'))

      const after = (
        db.prepare('SELECT * FROM crdt_updates ORDER BY id').all() as Array<Record<string, unknown>>
      ).map((row) => {
        expect(row.update_hash).toBeNull()
        const copy = { ...row }
        delete copy.update_hash
        return copy
      })
      expect(after).toEqual(before)
      expect(
        db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_crdt_updates_note_hash'`).get()
      ).toEqual({ sql: expect.stringMatching(/UNIQUE INDEX[\s\S]*WHERE update_hash IS NOT NULL/) })
    } finally {
      db.close()
    }
  })
})
