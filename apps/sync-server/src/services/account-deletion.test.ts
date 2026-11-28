import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { deleteUserData } from './account-deletion'
import { createMemoryR2, createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import type { Bindings } from '../types'

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
    first: vi.fn().mockResolvedValue(null),
    _sql: sql
  })),
  batch: vi.fn().mockResolvedValue([])
})

const makeEnv = (db: ReturnType<typeof makeDb>, bucket: ReturnType<typeof makeR2Bucket>) =>
  ({ DB: db, STORAGE: bucket }) as unknown as Bindings

describe('deleteUserData', () => {
  let bucket: ReturnType<typeof makeR2Bucket>
  let db: ReturnType<typeof makeDb>

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists R2 objects with the user prefix and deletes them', async () => {
    bucket = makeR2Bucket([{ keys: ['user-1/vaults/default/items/abc'], truncated: false }])
    db = makeDb()

    await deleteUserData(makeEnv(db, bucket), 'user-1', 'test@example.com')

    expect(bucket.list).toHaveBeenCalledWith({ prefix: 'user-1/', cursor: undefined })
    expect(bucket.delete).toHaveBeenCalledWith(['user-1/vaults/default/items/abc'])
  })

  it('paginates through multiple R2 pages', async () => {
    bucket = makeR2Bucket([
      { keys: ['user-1/a'], truncated: true },
      { keys: ['user-1/b'], truncated: false }
    ])
    db = makeDb()

    await deleteUserData(makeEnv(db, bucket), 'user-1', 'test@example.com')

    expect(bucket.list).toHaveBeenCalledTimes(2)
    expect(bucket.delete).toHaveBeenCalledTimes(2)
    expect(bucket.delete).toHaveBeenNthCalledWith(1, ['user-1/a'])
    expect(bucket.delete).toHaveBeenNthCalledWith(2, ['user-1/b'])
  })

  it('skips R2 delete when a page has no objects', async () => {
    bucket = makeR2Bucket([{ keys: [], truncated: false }])
    db = makeDb()

    await deleteUserData(makeEnv(db, bucket), 'user-1', 'test@example.com')

    expect(bucket.delete).not.toHaveBeenCalled()
  })

  it('calls db.batch with statements covering all user tables, users row last', async () => {
    bucket = makeR2Bucket([{ keys: [], truncated: false }])
    db = makeDb()

    await deleteUserData(makeEnv(db, bucket), 'user-1', 'test@example.com')

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
      'paddle_grants',
      'app_store_grants',
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

// A deleted account kept its Paddle subscription, so Paddle went on billing an account that no
// longer existed.
describe('deleteUserData with a Paddle subscription', () => {
  const USER_ID = 'user-1'
  let harness: SqliteD1

  beforeEach(() => {
    harness = createSqliteD1()
    harness.raw
      .prepare(
        `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
         VALUES (?, 'test@example.com', 1, 'email', 0, 0, 1, 1)`
      )
      .run(USER_ID)
  })

  afterEach(() => harness.close())

  const seedPaddleGrant = () =>
    harness.raw
      .prepare(
        `INSERT INTO paddle_grants (user_id, plan, cadence, status, paddle_customer_id, paddle_subscription_id, updated_at)
         VALUES (?, 'plus', 'monthly', 'active', 'ctm_1', 'sub_1', 1)`
      )
      .run(USER_ID)

  const paddle = (subscription: Record<string, unknown>, cancelStatus = 200) =>
    vi.fn(async (url: string) =>
      url.endsWith('/cancel')
        ? new Response(JSON.stringify({ data: { ...subscription, status: 'canceled' } }), {
            status: cancelStatus
          })
        : Response.json({ data: subscription })
    )

  const envWith = (paddleFetch: ReturnType<typeof paddle>) =>
    ({
      DB: harness.db,
      STORAGE: createMemoryR2(),
      PADDLE_API_KEY: 'pdl_sandbox_key',
      PADDLE_ENVIRONMENT: 'sandbox',
      fetch: paddleFetch
    }) as unknown as Bindings

  const userExists = () =>
    harness.raw.prepare('SELECT 1 FROM users WHERE id = ?').get(USER_ID) !== undefined

  const cancelCalls = (paddleFetch: ReturnType<typeof paddle>) =>
    paddleFetch.mock.calls.filter(([url]) => url.endsWith('/cancel'))

  it('cancels the subscription immediately, then deletes the account', async () => {
    seedPaddleGrant()
    const paddleFetch = paddle({ id: 'sub_1', status: 'active', custom_data: { userId: USER_ID } })

    await deleteUserData(envWith(paddleFetch), USER_ID, 'test@example.com')

    const [[url, init]] = cancelCalls(paddleFetch) as unknown as [[string, { body: string }]]
    expect(url).toBe('https://sandbox-api.paddle.com/subscriptions/sub_1/cancel')
    expect(JSON.parse(init.body)).toEqual({ effective_from: 'immediately' })
    expect(userExists()).toBe(false)
  })

  it('keeps the account when Paddle refuses the cancel', async () => {
    seedPaddleGrant()
    const paddleFetch = paddle({ id: 'sub_1', status: 'active' }, 500)

    await expect(
      deleteUserData(envWith(paddleFetch), USER_ID, 'test@example.com')
    ).rejects.toMatchObject({ statusCode: 502 })
    expect(userExists()).toBe(true)
  })

  it('deletes without calling Paddle when the user never subscribed', async () => {
    const paddleFetch = paddle({})

    await deleteUserData(envWith(paddleFetch), USER_ID, 'test@example.com')

    expect(paddleFetch).not.toHaveBeenCalled()
    expect(userExists()).toBe(false)
  })

  it.each([
    ['already canceled', { id: 'sub_1', status: 'canceled' }],
    ['owned by another account', { id: 'sub_1', status: 'active', custom_data: { userId: 'u2' } }]
  ])('leaves a subscription %s alone and deletes the account', async (_, subscription) => {
    seedPaddleGrant()
    const paddleFetch = paddle(subscription)

    await deleteUserData(envWith(paddleFetch), USER_ID, 'test@example.com')

    expect(cancelCalls(paddleFetch)).toHaveLength(0)
    expect(userExists()).toBe(false)
  })
})
