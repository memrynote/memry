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

  function seedRow(values: Partial<typeof vaultLocks.$inferInsert> = {}): void {
    testDb.db
      .insert(vaultLocks)
      .values({
        id: 'folder:projects',
        targetKind: 'folder',
        target: 'projects',
        locked: true,
        clock: { 'device-a': 2 },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        ...values
      })
      .run()
  }

  it('keeps the local lock when the remote change is older', () => {
    seedRow()

    const result = vaultLockHandler.applyUpsert(
      ctx,
      'folder:projects',
      { locked: false },
      { 'device-a': 1 }
    )

    expect(result).toBe('skipped')
    expect(row()?.locked).toBe(true)
    expect(mocks.onRemoteVaultLockApplied).not.toHaveBeenCalled()
  })

  it('takes the remote state of a concurrent change and reports a conflict', () => {
    seedRow()

    const result = vaultLockHandler.applyUpsert(
      ctx,
      'folder:projects',
      { locked: false, updatedAt: '2026-01-03T00:00:00.000Z' },
      { 'device-b': 1 }
    )

    expect(result).toBe('conflict')
    expect(row()).toMatchObject({
      locked: false,
      clock: { 'device-a': 2, 'device-b': 1 },
      updatedAt: '2026-01-03T00:00:00.000Z'
    })
    expect(mocks.onRemoteVaultLockApplied).toHaveBeenCalledWith('projects')
  })

  it('does not insert a lock from a payload missing its target', () => {
    const result = vaultLockHandler.applyUpsert(
      ctx,
      'folder:projects',
      { targetKind: 'folder', locked: true },
      { 'device-b': 1 }
    )

    expect(result).toBe('skipped')
    expect(testDb.db.select().from(vaultLocks).all()).toEqual([])
  })

  it('treats a remote delete as an unlock of the folder', () => {
    seedRow()

    expect(vaultLockHandler.applyDelete(ctx, 'folder:projects', { 'device-a': 3 })).toBe('applied')

    expect(row()).toBeUndefined()
    expect(mocks.onRemoteVaultLockApplied).toHaveBeenCalledWith('projects')
  })

  it('skips a delete of a missing lock and a delete older than the local lock', () => {
    expect(vaultLockHandler.applyDelete(ctx, 'folder:projects', { 'device-a': 1 })).toBe('skipped')

    seedRow({ clock: { 'device-a': 5 } })
    expect(vaultLockHandler.applyDelete(ctx, 'folder:projects', { 'device-a': 1 })).toBe('skipped')

    expect(row()?.locked).toBe(true)
    expect(mocks.onRemoteVaultLockApplied).not.toHaveBeenCalled()
  })

  it('reads the local row and stamps it synced after a push', () => {
    seedRow({ syncedAt: null })

    vaultLockHandler.markPushSynced(ctx.db, 'folder:projects')

    expect(vaultLockHandler.fetchLocal(ctx.db, 'folder:projects')).toMatchObject({
      target: 'projects',
      syncedAt: expect.any(String)
    })
    expect(vaultLockHandler.buildPushPayload(ctx.db, 'missing', 'device-a', 'update')).toBeNull()
  })

  it('seeds locks made before sync with a clock and queues them as creates', () => {
    seedRow({ clock: null })
    seedRow({ id: 'note:n1', targetKind: 'note', target: 'n1', clock: { 'device-a': 1 } })
    const queue = { enqueue: vi.fn() }

    const seeded = vaultLockHandler.seedUnclocked(
      ctx.db,
      'device-a',
      queue as unknown as Parameters<typeof vaultLockHandler.seedUnclocked>[2]
    )

    expect(seeded).toBe(1)
    expect(row()?.clock).toEqual({ 'device-a': 1 })
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'vault_lock',
        itemId: 'folder:projects',
        operation: 'create'
      })
    )
  })
})
