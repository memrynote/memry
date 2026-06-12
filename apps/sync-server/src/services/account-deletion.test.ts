import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deleteUserData } from './account-deletion'

const makeR2Bucket = (pages: { keys: string[]; truncated: boolean }[]) => {
  let callIndex = 0
  return {
    list: vi.fn().mockImplementation(() => {
      const page = pages[callIndex++] ?? { keys: [], truncated: false }
      return Promise.resolve({
        objects: page.keys.map((key) => ({ key })),
        truncated: page.truncated,
        cursor: page.truncated ? `cursor-${callIndex}` : undefined
      })
    }),
    delete: vi.fn().mockResolvedValue(undefined)
  }
}

const makeDb = () => ({
  prepare: vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    _sql: sql
  })),
  batch: vi.fn().mockResolvedValue([])
})

describe('deleteUserData', () => {
  let bucket: ReturnType<typeof makeR2Bucket>
  let db: ReturnType<typeof makeDb>

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists R2 objects with the user prefix and deletes them', async () => {
    bucket = makeR2Bucket([{ keys: ['user-1/vaults/default/items/abc'], truncated: false }])
    db = makeDb()

    await deleteUserData(
      db as unknown as D1Database,
      bucket as unknown as R2Bucket,
      'user-1',
      'test@example.com'
    )

    expect(bucket.list).toHaveBeenCalledWith({ prefix: 'user-1/', cursor: undefined })
    expect(bucket.delete).toHaveBeenCalledWith(['user-1/vaults/default/items/abc'])
  })

  it('paginates through multiple R2 pages', async () => {
    bucket = makeR2Bucket([
      { keys: ['user-1/a'], truncated: true },
      { keys: ['user-1/b'], truncated: false }
    ])
    db = makeDb()

    await deleteUserData(
      db as unknown as D1Database,
      bucket as unknown as R2Bucket,
      'user-1',
      'test@example.com'
    )

    expect(bucket.list).toHaveBeenCalledTimes(2)
    expect(bucket.delete).toHaveBeenCalledTimes(2)
    expect(bucket.delete).toHaveBeenNthCalledWith(1, ['user-1/a'])
    expect(bucket.delete).toHaveBeenNthCalledWith(2, ['user-1/b'])
  })

  it('skips R2 delete when a page has no objects', async () => {
    bucket = makeR2Bucket([{ keys: [], truncated: false }])
    db = makeDb()

    await deleteUserData(
      db as unknown as D1Database,
      bucket as unknown as R2Bucket,
      'user-1',
      'test@example.com'
    )

    expect(bucket.delete).not.toHaveBeenCalled()
  })

  it('calls db.batch with statements covering all user tables, users row last', async () => {
    bucket = makeR2Bucket([{ keys: [], truncated: false }])
    db = makeDb()

    await deleteUserData(
      db as unknown as D1Database,
      bucket as unknown as R2Bucket,
      'user-1',
      'test@example.com'
    )

    expect(db.batch).toHaveBeenCalledTimes(1)
    const statements: Array<{ _sql: string }> = db.batch.mock.calls[0][0]

    // users row must be last
    const lastSql = statements[statements.length - 1]._sql
    expect(lastSql).toMatch(/DELETE FROM users WHERE id/)

    // otp_codes must be present (keyed by email)
    const otpSql = statements.find((s) => s._sql.includes('otp_codes'))
    expect(otpSql).toBeDefined()
    expect(otpSql!._sql).toMatch(/email/)

    // child tables must all appear
    const allSql = statements.map((s) => s._sql).join('\n')
    const requiredTables = [
      'google_calendar_channels',
      'crdt_updates',
      'crdt_snapshots',
      'upload_sessions',
      'blob_chunks',
      'device_sync_state',
      'sync_items',
      'server_cursor_sequence',
      'linking_sessions',
      'refresh_tokens',
      'sync_entitlements',
      'sync_vaults',
      'consumed_setup_tokens',
      'devices',
      'user_identities',
      'otp_codes'
    ]
    for (const table of requiredTables) {
      expect(allSql, `missing table: ${table}`).toContain(table)
    }
  })
})
