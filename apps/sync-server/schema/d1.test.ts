import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CHUNK_CRYPTO_OVERHEAD, expectedEncryptedTotal } from '../src/services/upload-size'

const migrationsDir = resolve(__dirname, '../migrations')

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
}

function loadMigrationSql(file: string): string {
  return readFileSync(join(migrationsDir, file), 'utf8')
}

// Canonical schema = the ordered D1 migrations wrangler applies on deploy.
function loadSchemaSql(): string {
  return migrationFiles().map(loadMigrationSql).join('\n')
}

describe('D1 schema', () => {
  it('creates all foundational tables and indexes', () => {
    const db = new Database(':memory:')
    db.exec(loadSchemaSql())

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name)

    expect(tables).toEqual(
      expect.arrayContaining([
        'users',
        'otp_codes',
        'refresh_tokens',
        'user_identities',
        'devices',
        'sync_entitlements',
        'sync_vaults',
        'paddle_webhook_events',
        'linking_sessions',
        'sync_items',
        'server_cursor_sequence',
        'device_sync_state',
        'rate_limits',
        'crdt_updates',
        'crdt_snapshots',
        'upload_sessions',
        'blob_chunks',
        'google_calendar_channels',
        'release_download_counts'
      ])
    )

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => (row as { name: string }).name)

    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_users_email',
        'idx_users_provider',
        'idx_otp_email',
        'idx_otp_expires',
        'idx_identity_user',
        'idx_devices_user',
        'idx_devices_user_active',
        'idx_devices_user_vault',
        'idx_sync_entitlements_subscription',
        'idx_sync_entitlements_customer',
        'idx_sync_vaults_user',
        'idx_refresh_user',
        'idx_refresh_device',
        'idx_linking_user',
        'idx_linking_expires',
        'idx_linking_status',
        'idx_sync_user_cursor',
        'idx_sync_type',
        'idx_sync_deleted',
        'idx_upload_user',
        'idx_upload_expires',
        'idx_blob_chunks_hash',
        'idx_google_channels_user',
        'idx_google_channels_expires'
      ])
    )
  })

  it('cascades google_calendar_channels rows on user and device deletion', () => {
    // #given
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(loadSchemaSql())

    const channelFks = db
      .prepare('PRAGMA foreign_key_list(google_calendar_channels)')
      .all() as Array<{
      table: string
      from: string
      to: string
      on_delete: string
    }>

    // #then
    expect(channelFks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'users',
          from: 'user_id',
          to: 'id',
          on_delete: 'CASCADE'
        }),
        expect.objectContaining({
          table: 'devices',
          from: 'device_id',
          to: 'id',
          on_delete: 'CASCADE'
        })
      ])
    )
  })

  it('defines expected foreign key relationships', () => {
    const db = new Database(':memory:')
    db.exec(loadSchemaSql())

    const refreshFks = db.prepare('PRAGMA foreign_key_list(refresh_tokens)').all() as Array<{
      table: string
      from: string
      to: string
      on_delete: string
    }>

    expect(refreshFks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'users',
          from: 'user_id',
          to: 'id',
          on_delete: 'CASCADE'
        }),
        expect.objectContaining({
          table: 'devices',
          from: 'device_id',
          to: 'id',
          on_delete: 'CASCADE'
        })
      ])
    )

    const syncItemFks = db.prepare('PRAGMA foreign_key_list(sync_items)').all() as Array<{
      table: string
      from: string
      to: string
      on_delete: string
    }>

    expect(syncItemFks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'users',
          from: 'user_id',
          to: 'id',
          on_delete: 'CASCADE'
        }),
        expect.objectContaining({ table: 'devices', from: 'signer_device_id', to: 'id' })
      ])
    )
  })

  it('stores sync records and cursors under a vault id', () => {
    const db = new Database(':memory:')
    db.exec(loadSchemaSql())

    const syncItemColumns = db.prepare('PRAGMA table_info(sync_items)').all() as Array<{
      name: string
    }>
    const cursorColumns = db.prepare('PRAGMA table_info(device_sync_state)').all() as Array<{
      name: string
    }>
    const crdtUpdateColumns = db.prepare('PRAGMA table_info(crdt_updates)').all() as Array<{
      name: string
    }>
    const crdtSnapshotColumns = db.prepare('PRAGMA table_info(crdt_snapshots)').all() as Array<{
      name: string
    }>
    const uploadSessionColumns = db.prepare('PRAGMA table_info(upload_sessions)').all() as Array<{
      name: string
    }>
    const blobChunkColumns = db.prepare('PRAGMA table_info(blob_chunks)').all() as Array<{
      name: string
    }>

    expect(syncItemColumns.map((column) => column.name)).toContain('vault_id')
    expect(cursorColumns.map((column) => column.name)).toContain('vault_id')
    expect(crdtUpdateColumns.map((column) => column.name)).toContain('vault_id')
    expect(crdtSnapshotColumns.map((column) => column.name)).toContain('vault_id')
    expect(crdtSnapshotColumns.map((column) => column.name)).toContain('revision')
    expect(uploadSessionColumns.map((column) => column.name)).toContain('vault_id')
    expect(blobChunkColumns.map((column) => column.name)).toContain('vault_id')
  })

  // Migrations are applied BEFORE the Worker deploys, so 0002 lands on rows the old
  // server wrote. Those rows must keep a NULL encrypted_size: the refund paths read
  // it as `?? total_size` (the plaintext they reserved), while the chunk cap and
  // `complete` need `expectedEncryptedTotal` to DERIVE the ciphertext total, which it
  // only does while the column is NULL. A backfill would break the second reader.
  describe('0002_upload_sessions_encrypted_size', () => {
    // A database at 0001 (pre-encrypted_size) with a user to own the sessions.
    const dbAtBaseline = () => {
      const db = new Database(':memory:')
      db.exec(loadMigrationSql('0001_baseline.sql'))
      db.prepare(
        `INSERT INTO users (id, email, auth_method, created_at, updated_at)
         VALUES ('user-1', 'a@b.com', 'otp', 1, 1)`
      ).run()
      return db
    }

    const insertLegacySession = (db: Database.Database, id: string, totalSize: number) =>
      db
        .prepare(
          `INSERT INTO upload_sessions
             (id, user_id, vault_id, attachment_id, filename, total_size, chunk_count, expires_at, created_at)
           VALUES (?, 'user-1', 'vault-1', ?, 'f.bin', ?, 3, 1, 1)`
        )
        .run(id, `att-${id}`, totalSize)

    it('leaves encrypted_size NULL on rows written before the column existed', () => {
      // #given a database at 0001 with in-flight sessions the old server reserved plaintext for
      const db = dbAtBaseline()
      insertLegacySession(db, 's1', 5_000)
      insertLegacySession(db, 's2', 500_000)

      // #when 0002 is applied
      db.exec(loadMigrationSql('0002_upload_sessions_encrypted_size.sql'))

      // #then the legacy rows keep NULL, so the refunds fall back to the plaintext they
      // reserved AND the wire-byte checks still derive the ciphertext total
      const rows = db
        .prepare('SELECT id, total_size, encrypted_size FROM upload_sessions ORDER BY id')
        .all() as Array<{ id: string; total_size: number; encrypted_size: number | null }>

      expect(rows).toEqual([
        { id: 's1', total_size: 5_000, encrypted_size: null },
        { id: 's2', total_size: 500_000, encrypted_size: null }
      ])
    })

    // Backfilling encrypted_size is the tempting "fix" for the legacy refund and it
    // silently breaks every in-flight upload. No other test can catch that: the unit
    // suites hand-build session rows and never apply the SQL, so this is the only
    // place the migration meets the code that reads it.
    it('leaves legacy rows deriving the ciphertext total the old client still sends', () => {
      // #given a legacy 3-chunk session the old server reserved 5,000 plaintext bytes for
      const db = dbAtBaseline()
      insertLegacySession(db, 's1', 5_000)

      // #when 0002 is applied and the server reads the row back
      db.exec(loadMigrationSql('0002_upload_sessions_encrypted_size.sql'))
      const row = db
        .prepare('SELECT total_size, chunk_count, encrypted_size FROM upload_sessions WHERE id = ?')
        .get('s1') as { total_size: number; chunk_count: number; encrypted_size: number | null }

      // #then the chunk cap and `complete` expect CIPHERTEXT — the old client still puts
      // nonce||tag on the wire — which only holds while the column is NULL
      expect(expectedEncryptedTotal(row.total_size, row.chunk_count, row.encrypted_size)).toBe(
        5_000 + CHUNK_CRYPTO_OVERHEAD * 3
      )

      // #and the refund still pays back only the PLAINTEXT that was actually reserved
      expect(row.encrypted_size ?? row.total_size).toBe(5_000)
    })
  })

  // The revision token is what lets a client skip a snapshot download it does not
  // need. Existing rows must survive the migration with '' — the server coalesces
  // that at read time — rather than being rewritten by a backfill UPDATE over what
  // could be millions of rows inside a D1 migration.
  describe('0005_crdt_snapshot_revision', () => {
    it('leaves rows written before the column existed with an empty revision', () => {
      // #given a database at 0004 with a snapshot the old server wrote
      const db = new Database(':memory:')
      for (const file of migrationFiles().filter((name) => name < '0005')) {
        db.exec(loadMigrationSql(file))
      }
      db.prepare(
        `INSERT INTO users (id, email, auth_method, created_at, updated_at)
         VALUES ('user-1', 'a@b.com', 'otp', 1, 1)`
      ).run()
      db.prepare(
        `INSERT INTO crdt_snapshots
           (id, user_id, vault_id, note_id, blob_key, sequence_num, size_bytes, signer_device_id, created_at)
         VALUES ('snap-1', 'user-1', 'vault-1', 'note-1', 'user-1/k', 7, 42, 'device-a', 1700000000)`
      ).run()

      // #when 0005 is applied
      db.exec(loadMigrationSql('0005_crdt_snapshot_revision.sql'))

      // #then the row is untouched apart from the defaulted column, so the read-time
      // coalesce is what gives it a token
      expect(
        db.prepare('SELECT id, created_at, size_bytes, revision FROM crdt_snapshots').get()
      ).toEqual({ id: 'snap-1', created_at: 1700000000, size_bytes: 42, revision: '' })
    })
  })
})
