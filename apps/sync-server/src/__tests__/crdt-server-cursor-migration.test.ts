import Database from 'better-sqlite3'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// #2295: migration 0011 adds server_cursor to both CRDT tables. It must apply
// on a database that already holds CRDT rows written through 0010 and leave
// every existing row exactly as it was, with a NULL cursor (no backfill).

const migrationsDir = resolve(__dirname, '../../migrations')
const MIGRATION = '0011_crdt_server_cursor.sql'

const migrationFiles = (): string[] =>
  readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()

const applyFiles = (db: Database.Database, files: string[]): void => {
  for (const file of files) db.exec(readFileSync(join(migrationsDir, file), 'utf8'))
}

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
})

afterEach(() => {
  db.close()
})

const seedCrdtRows = (): void => {
  db.prepare(
    `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
     VALUES ('user-1', 'u1@example.com', 1, 'otp', 0, 0, 1, 1)`
  ).run()
  const insertUpdate = db.prepare(
    `INSERT INTO crdt_updates (id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at, client_platform, client_version)
     VALUES (?, 'user-1', 'default', ?, ?, ?, 'device-1', 100, NULL, NULL)`
  )
  insertUpdate.run('u-1', 'note-1', Buffer.from([1, 2, 3]), 1)
  insertUpdate.run('u-2', 'note-1', Buffer.from([4, 5]), 2)
  insertUpdate.run('u-3', 'note-2', Buffer.alloc(70_000, 7), 1)
  db.prepare(
    `INSERT INTO crdt_snapshots (id, user_id, vault_id, note_id, blob_key, sequence_num, size_bytes, signer_device_id, created_at, revision)
     VALUES ('s-1', 'user-1', 'default', 'note-1', 'user-1/default/crdt/note-1', 2, 10, 'device-1', 100, '')`
  ).run()
}

const rowsWithout = (table: string, column: string): Array<Record<string, unknown>> =>
  (db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Array<Record<string, unknown>>).map(
    (row) => {
      const copy = { ...row }
      delete copy[column]
      return copy
    }
  )

describe('migration 0011_crdt_server_cursor (#2295)', () => {
  it('is the next migration after 0010', () => {
    const files = migrationFiles()
    expect(files).toContain(MIGRATION)
    expect(files[files.indexOf(MIGRATION) - 1]).toBe('0010_sync_items_committed_at_ms.sql')
  })

  it('applies on a populated database without touching existing CRDT rows', () => {
    const files = migrationFiles()
    applyFiles(
      db,
      files.filter((file) => file < MIGRATION)
    )
    seedCrdtRows()
    const updatesBefore = db.prepare('SELECT * FROM crdt_updates ORDER BY id').all()
    const snapshotsBefore = db.prepare('SELECT * FROM crdt_snapshots ORDER BY id').all()

    applyFiles(db, [MIGRATION])

    expect(rowsWithout('crdt_updates', 'server_cursor')).toEqual(updatesBefore)
    expect(rowsWithout('crdt_snapshots', 'server_cursor')).toEqual(snapshotsBefore)
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT server_cursor FROM crdt_updates UNION ALL SELECT server_cursor FROM crdt_snapshots
           ) WHERE server_cursor IS NOT NULL`
        )
        .get()
    ).toEqual({ n: 0 })

    const indexes = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('crdt_updates', 'crdt_snapshots')`
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_crdt_updates_user_cursor', 'idx_crdt_snapshots_user_cursor'])
    )
  })

  it('serves a cursor range read from the new index', () => {
    applyFiles(db, migrationFiles())

    const plan = (table: string): string =>
      (
        db
          .prepare(
            `EXPLAIN QUERY PLAN SELECT server_cursor FROM ${table}
             WHERE user_id = ? AND vault_id = ? AND server_cursor > ? ORDER BY server_cursor LIMIT ?`
          )
          .all('user-1', 'default', 0, 10) as Array<{ detail: string }>
      )
        .map((row) => row.detail)
        .join(' | ')

    expect(plan('crdt_updates')).toContain('idx_crdt_updates_user_cursor')
    expect(plan('crdt_snapshots')).toContain('idx_crdt_snapshots_user_cursor')
    expect(plan('crdt_updates')).not.toContain('TEMP B-TREE')
  })
})
