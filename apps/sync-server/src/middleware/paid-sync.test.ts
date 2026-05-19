import { describe, expect, it, vi } from 'vitest'

import { ErrorCodes } from '../lib/errors'
import { SYNC_PLAN_LIMITS, type SyncEntitlement } from '../services/entitlements'
import { paidSyncMiddleware } from './paid-sync'

function entitlement(overrides: Partial<SyncEntitlement> = {}): SyncEntitlement {
  return {
    user_id: 'user-1',
    storage_used: 0,
    plan: 'plus',
    status: 'active',
    source: 'paddle',
    storage_limit: SYNC_PLAN_LIMITS.plus.storageLimit,
    max_file_size: SYNC_PLAN_LIMITS.plus.maxFileSize,
    max_vaults: SYNC_PLAN_LIMITS.plus.maxVaults,
    version_history_days: SYNC_PLAN_LIMITS.plus.versionHistoryDays,
    paddle_customer_id: null,
    paddle_subscription_id: null,
    paddle_transaction_id: null,
    expires_at: null,
    ...overrides
  }
}

function statement(result: unknown = null) {
  const stmt = {
    bind: vi.fn(),
    first: vi.fn().mockResolvedValue(result),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } })
  }
  stmt.bind.mockReturnValue(stmt)
  return stmt
}

function createDb(entitlementRow: SyncEntitlement) {
  const statements: string[] = []
  const db = {
    prepare: vi.fn((sql: string) => {
      statements.push(sql)
      if (sql.includes('FROM users')) return statement(entitlementRow)
      if (sql.includes('vault_id = ?')) return statement(null)
      if (sql.includes('COUNT(*)')) return statement({ cnt: 0 })
      return statement()
    })
  }

  return { db: db as unknown as D1Database, statements }
}

function createContext(db: D1Database, vaultHeader?: string) {
  const values = new Map<string, unknown>([
    ['userId', 'user-1'],
    ['vaultId', 'device-vault']
  ])

  return {
    req: {
      header: vi.fn((name: string) => (name === 'X-Memry-Vault-Id' ? vaultHeader : undefined))
    },
    env: { DB: db },
    get: vi.fn((key: string) => values.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      values.set(key, value)
    })
  }
}

describe('paid sync middleware', () => {
  it('rejects sync requests without an active paid entitlement', async () => {
    const { db } = createDb(entitlement({ status: 'inactive' }))
    const context = createContext(db)

    await expect(
      paidSyncMiddleware(
        context as never,
        vi.fn(async () => undefined)
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.SYNC_PAYMENT_REQUIRED,
      statusCode: 402
    })
  })

  it('registers the request vault and exposes the entitlement before continuing', async () => {
    const { db, statements } = createDb(entitlement())
    const context = createContext(db, 'vault-from-request')
    const next = vi.fn(async () => undefined)

    await paidSyncMiddleware(context as never, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(context.set).toHaveBeenCalledWith('vaultId', 'vault-from-request')
    expect(context.set).toHaveBeenCalledWith(
      'syncEntitlement',
      expect.objectContaining({ plan: 'plus' })
    )
    expect(statements.some((sql) => sql.includes('INSERT INTO sync_vaults'))).toBe(true)
  })
})
