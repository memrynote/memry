import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { vaultLocks } from '@memry/db-schema/schema/vault-locks'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const mocks = vi.hoisted(() => ({ onRemoteVaultLockApplied: vi.fn() }))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../../vault-locks/service', () => ({
  onRemoteVaultLockApplied: mocks.onRemoteVaultLockApplied
}))

import { vaultLockHandler } from './vault-lock-handler'

describe('vaultLockHandler (#2606)', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  const row = () =>
    testDb.db.select().from(vaultLocks).where(eq(vaultLocks.id, 'folder:projects')).get()

  beforeEach(() => {
    vi.clearAllMocks()
    testDb = createTestDataDb()
    ctx = { db: testDb.db as unknown as DrizzleDb, emit: vi.fn() }
  })

  afterEach(() => {
    testDb.close()
  })

  it('applies a lock from another device and re-protects the files', () => {
    const result = vaultLockHandler.applyUpsert(
      ctx,
      'folder:projects',
      { targetKind: 'folder', target: 'projects', locked: true },
      { 'device-b': 1 }
    )

    expect(result).toBe('applied')
    expect(row()).toMatchObject({ targetKind: 'folder', target: 'projects', locked: true })
    expect(mocks.onRemoteVaultLockApplied).toHaveBeenCalledWith(undefined)
  })

  it('applies an unlock as an update and frees the folder files', () => {
    vaultLockHandler.applyUpsert(
      ctx,
      'folder:projects',
      { targetKind: 'folder', target: 'projects', locked: true },
      { 'device-b': 1 }
    )

    const result = vaultLockHandler.applyUpsert(
      ctx,
      'folder:projects',
      { locked: false },
      { 'device-b': 2 }
    )

    expect(result).toBe('applied')
    expect(row()?.locked).toBe(false)
    expect(mocks.onRemoteVaultLockApplied).toHaveBeenLastCalledWith('projects')
  })

  it('skips a target kind this build does not know instead of guessing', () => {
    const result = vaultLockHandler.applyUpsert(
      ctx,
      'tag:work',
      { targetKind: 'tag', target: 'work', locked: true },
      { 'device-b': 1 }
    )

    expect(result).toBe('skipped')
    expect(testDb.db.select().from(vaultLocks).all()).toEqual([])
    expect(mocks.onRemoteVaultLockApplied).not.toHaveBeenCalled()
  })

  it('pushes the row with its lock state', () => {
    testDb.db
      .insert(vaultLocks)
      .values({
        id: 'folder:projects',
        targetKind: 'folder',
        target: 'projects',
        locked: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      })
      .run()

    const payload = vaultLockHandler.buildPushPayload(
      ctx.db,
      'folder:projects',
      'device-a',
      'update'
    )

    expect(JSON.parse(payload ?? '{}')).toMatchObject({
      targetKind: 'folder',
      target: 'projects',
      locked: false
    })
  })
})
