import { describe, expect, it, vi } from 'vitest'

import { ErrorCodes } from '../lib/errors'
import { SYNC_PLAN_LIMITS, type SyncEntitlement } from '../services/entitlements'
import { paidSyncMiddleware } from './paid-sync'

function entitlement(overrides: Partial<SyncEntitlement> = {}): SyncEntitlement {
  return {
    user_id: 'user-1',
    storage_used: 0,
    plan: 'plus',
    cadence: 'monthly',
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

  // A desktop whose vault database is not open yet sends no header at all
  // (getSyncVaultHeaders swallows the failure). Defaulting that to 'default'
  // used to UPSERT a phantom vault, which on Plus (1 vault) permanently locked
  // the user's real vault out of sync behind a 402 no payment could clear.
  describe('a request with no vault header', () => {
    function createHeaderlessContext(db: D1Database) {
      const values = new Map<string, unknown>([['userId', 'user-1']])
      return {
        req: { header: vi.fn(() => undefined) },
        env: { DB: db },
        get: vi.fn((key: string) => values.get(key)),
        set: vi.fn((key: string, value: unknown) => {
          values.set(key, value)
        })
      }
    }

    function createVaultLookupDb(
      lookup: { cnt: number; hasLegacy: number; onlyVaultId: string | null },
      entitlementRow = entitlement()
    ) {
      const statements: string[] = []
      const db = {
        prepare: vi.fn((sql: string) => {
          statements.push(sql)
          if (sql.includes('MAX(CASE WHEN vault_id')) return statement(lookup)
          if (sql.includes('FROM users')) return statement(entitlementRow)
          if (sql.includes('vault_id = ?')) return statement({ vault_id: 'x' })
          if (sql.includes('COUNT(*)')) return statement({ cnt: 1 })
          return statement()
        })
      }
      return { db: db as unknown as D1Database, statements }
    }

    it('resolves to the account\u2019s only vault instead of minting "default"', async () => {
      const { db, statements } = createVaultLookupDb({
        cnt: 1,
        hasLegacy: 0,
        onlyVaultId: 'real-vault-uuid'
      })
      const context = createHeaderlessContext(db)
      const next = vi.fn(async () => undefined)

      await paidSyncMiddleware(context as never, next)

      expect(context.set).toHaveBeenCalledWith('vaultId', 'real-vault-uuid')
      expect(statements.some((sql) => sql.includes('INSERT INTO sync_vaults'))).toBe(false)
      expect(next).toHaveBeenCalledTimes(1)
    })

    it('keeps serving a legacy account that already has a "default" vault', async () => {
      const { db } = createVaultLookupDb({ cnt: 2, hasLegacy: 1, onlyVaultId: 'default' })
      const context = createHeaderlessContext(db)

      await paidSyncMiddleware(
        context as never,
        vi.fn(async () => undefined)
      )

      expect(context.set).toHaveBeenCalledWith('vaultId', 'default')
    })

    it('still serves the first-ever sync of an account with no vaults', async () => {
      const { db } = createVaultLookupDb({ cnt: 0, hasLegacy: 0, onlyVaultId: null })
      const context = createHeaderlessContext(db)

      await paidSyncMiddleware(
        context as never,
        vi.fn(async () => undefined)
      )

      expect(context.set).toHaveBeenCalledWith('vaultId', 'default')
    })

    it('refuses to guess on a multi-vault account rather than consume a slot', async () => {
      const { db, statements } = createVaultLookupDb({
        cnt: 2,
        hasLegacy: 0,
        onlyVaultId: 'vault-a'
      })
      const context = createHeaderlessContext(db)

      await expect(
        paidSyncMiddleware(
          context as never,
          vi.fn(async () => undefined)
        )
      ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_ERROR, statusCode: 400 })
      expect(statements.some((sql) => sql.includes('INSERT INTO sync_vaults'))).toBe(false)
    })
  })
})
