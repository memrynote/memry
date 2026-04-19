import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadSchemaSql(): string {
  return readFileSync(resolve(__dirname, 'd1.sql'), 'utf8')
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
        'linking_sessions',
        'sync_items',
        'server_cursor_sequence',
        'device_sync_state',
        'rate_limits',
        'crdt_updates',
        'crdt_snapshots',
        'upload_sessions',
        'blob_chunks',
        'google_calendar_channels'
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
})
