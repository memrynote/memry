import { describe, expect, it, vi } from 'vitest'

import { ErrorCodes } from '../lib/errors'
import {
  SYNC_PLAN_LIMITS,
  assertFileSizeAllowed,
  assertPaidSyncAccess,
  ensureLocalAdminPaidSyncAccess,
  ensureLocalAdminPaidSyncAccessForUser,
  ensureSyncVaultAllowed,
  isPaidSyncEntitlementActive,
  type SyncEntitlement
} from './entitlements'

const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024

interface MockStatement {
  bind: ReturnType<typeof vi.fn>
  first: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
}

function statement(result: unknown = null, changes = 1): MockStatement {
  const stmt: MockStatement = {
    bind: vi.fn(),
    first: vi.fn().mockResolvedValue(result),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes } })
  }
  stmt.bind.mockReturnValue(stmt)
  return stmt
}

function entitlementRow(overrides: Partial<SyncEntitlement> = {}): SyncEntitlement {
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

function entitlementDb(row: unknown) {
  return {
    prepare: vi.fn(() => statement(row))
  } as unknown as D1Database
}

function vaultDb(options: {
  existing?: boolean | boolean[]
  count?: number
  insertChanges?: number
}) {
  const statements: string[] = []
  let existingReads = 0
  const db = {
    prepare: vi.fn((sql: string) => {
      statements.push(sql)
      if (sql.includes('FROM sync_vaults') && sql.includes('vault_id = ?')) {
        const existing = Array.isArray(options.existing)
          ? options.existing[existingReads++]
          : options.existing
        return statement(existing ? { vault_id: 'vault-1' } : null)
      }
      if (sql.includes('INSERT INTO sync_vaults')) {
        return statement(null, options.insertChanges ?? 1)
      }
      if (sql.includes('COUNT(*)')) {
        return statement({ cnt: options.count ?? 0 })
      }
      return statement()
    })
  }

  return { db: db as unknown as D1Database, statements }
}

describe('sync plan entitlements', () => {
  it('defines the paid plan limits requested for Plus, Pro, and Believer', () => {
    expect(SYNC_PLAN_LIMITS.plus).toEqual({
      storageLimit: 1 * GIB,
      maxVaults: 1,
      maxFileSize: 5 * MIB,
      versionHistoryDays: 30
    })
    expect(SYNC_PLAN_LIMITS.pro).toEqual({
      storageLimit: 10 * GIB,
      maxVaults: 10,
      maxFileSize: 200 * MIB,
      versionHistoryDays: 365
    })
    expect(SYNC_PLAN_LIMITS.believer).toEqual({
      storageLimit: 50 * GIB,
      maxVaults: null,
      maxFileSize: 200 * MIB,
      versionHistoryDays: 365
    })
  })

  it('treats only active paid entitlements as sync-enabled', () => {
    expect(isPaidSyncEntitlementActive(entitlementRow())).toBe(true)
    expect(isPaidSyncEntitlementActive(entitlementRow({ plan: 'free' }))).toBe(false)
    expect(isPaidSyncEntitlementActive(entitlementRow({ status: 'canceled' }))).toBe(false)
    expect(isPaidSyncEntitlementActive(entitlementRow({ expires_at: 1 }), 2)).toBe(false)
    expect(
      isPaidSyncEntitlementActive(entitlementRow({ source: 'admin_override', expires_at: null }), 2)
    ).toBe(true)
  })

  it('rejects users without an active paid sync entitlement', async () => {
    const db = entitlementDb(entitlementRow({ status: 'inactive' }))

    await expect(assertPaidSyncAccess(db, 'user-1')).rejects.toMatchObject({
      code: ErrorCodes.SYNC_PAYMENT_REQUIRED,
      statusCode: 402
    })
  })

  it('allows active paid users and exposes their limits', async () => {
    const db = entitlementDb(entitlementRow({ plan: 'pro', storage_limit: 10 * GIB }))

    const entitlement = await assertPaidSyncAccess(db, 'user-1')

    expect(entitlement.plan).toBe('pro')
    expect(entitlement.storage_limit).toBe(10 * GIB)
  })

  it('grants the local admin email a development Believer entitlement', async () => {
    const db = {
      prepare: vi.fn(() => statement())
    } as unknown as D1Database

    await ensureLocalAdminPaidSyncAccess(db, 'development', 'KAAN@MEMRYNOTE.COM', 'user-1')

    const prepareMock = db.prepare as unknown as ReturnType<typeof vi.fn>
    const entitlementStatement = prepareMock.mock.results.find(({ value }) =>
      (value as MockStatement).bind.mock.calls.some((args) => args[1] === 'believer')
    )!.value as MockStatement

    expect(entitlementStatement.bind.mock.calls[0].slice(0, 8)).toEqual([
      'user-1',
      'believer',
      'active',
      'dev_seed',
      SYNC_PLAN_LIMITS.believer.storageLimit,
      SYNC_PLAN_LIMITS.believer.maxFileSize,
      SYNC_PLAN_LIMITS.believer.maxVaults,
      SYNC_PLAN_LIMITS.believer.versionHistoryDays
    ])
  })

  it('does not grant the local admin entitlement outside development', async () => {
    const db = {
      prepare: vi.fn(() => statement())
    } as unknown as D1Database

    await ensureLocalAdminPaidSyncAccess(db, 'production', 'kaan@memrynote.com', 'user-1')

    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('can grant the local admin entitlement from an existing user id', async () => {
    const userStatement = statement({ email: 'kaan@memrynote.com' })
    const entitlementStatement = statement()
    const updateUserStatement = statement()
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT email FROM users')) return userStatement
        if (sql.includes('INSERT INTO sync_entitlements')) return entitlementStatement
        return updateUserStatement
      })
    } as unknown as D1Database

    await ensureLocalAdminPaidSyncAccessForUser(db, 'development', 'user-1')

    expect(userStatement.bind).toHaveBeenCalledWith('user-1')
    expect(entitlementStatement.bind.mock.calls[0].slice(0, 4)).toEqual([
      'user-1',
      'believer',
      'active',
      'dev_seed'
    ])
  })

  it('enforces per-file limits from the active paid plan', async () => {
    const db = entitlementDb(entitlementRow({ max_file_size: 5 * MIB }))

    await expect(assertFileSizeAllowed(db, 'user-1', 5 * MIB)).resolves.toBeUndefined()
    await expect(assertFileSizeAllowed(db, 'user-1', 5 * MIB + 1)).rejects.toMatchObject({
      code: ErrorCodes.STORAGE_FILE_TOO_LARGE,
      statusCode: 413
    })
  })

  it('blocks a second synced vault for Plus', async () => {
    const { db } = vaultDb({ existing: false, count: 1 })

    await expect(
      ensureSyncVaultAllowed(db, 'user-1', 'vault-2', entitlementRow())
    ).rejects.toMatchObject({
      code: ErrorCodes.SYNC_VAULT_LIMIT_EXCEEDED,
      statusCode: 402
    })
  })

  it('allows existing vaults and unlimited Believer vaults', async () => {
    const existing = vaultDb({ existing: true, count: 1 })
    await expect(
      ensureSyncVaultAllowed(existing.db, 'user-1', 'vault-1', entitlementRow())
    ).resolves.toBeUndefined()

    const believer = vaultDb({ existing: false, count: 999 })
    await expect(
      ensureSyncVaultAllowed(
        believer.db,
        'user-1',
        'vault-1000',
        entitlementRow({ plan: 'believer', max_vaults: null })
      )
    ).resolves.toBeUndefined()
  })

  it('rejects a new vault when the guarded insert is blocked by a concurrent limit race', async () => {
    const { db } = vaultDb({ existing: false, count: 0, insertChanges: 0 })

    await expect(
      ensureSyncVaultAllowed(db, 'user-1', 'vault-2', entitlementRow())
    ).rejects.toMatchObject({
      code: ErrorCodes.SYNC_VAULT_LIMIT_EXCEEDED,
      statusCode: 402
    })
  })

  it('allows the same vault when a concurrent request registered it before the count check', async () => {
    const { db } = vaultDb({ existing: [false, true], count: 1 })

    await expect(
      ensureSyncVaultAllowed(db, 'user-1', 'vault-1', entitlementRow())
    ).resolves.toBeUndefined()
  })
})
