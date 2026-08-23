import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import type { FolderConfigSyncPayload } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

type MockQueue = Pick<SyncQueueManager, 'enqueue'> & { enqueue: ReturnType<typeof vi.fn> }

function makeMockQueue(): { mock: MockQueue; queue: SyncQueueManager } {
  const mock: MockQueue = { enqueue: vi.fn() }
  return { mock, queue: mock as unknown as SyncQueueManager }
}

vi.mock('../../vault/folders', () => ({
  writeFolderConfig: vi.fn(),
  readFolderConfig: vi.fn()
}))

// Shared stub (not a fresh object per createLogger call) so the vault-write
// failure paths can be asserted on.
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => logger
}))

import { folderConfigHandler } from './folder-config-handler'
import { writeFolderConfig, readFolderConfig } from '../../vault/folders'
import { VaultError, VaultErrorCode } from '../../lib/errors'

/**
 * The vault mirror write is fire-and-forget, so give Node a chance to drain the
 * microtask queue and emit `unhandledRejection` before asserting on it.
 */
async function flushPendingRejections(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

/** Records anything Node reports as an unhandled rejection while `run` executes. */
async function captureUnhandledRejections(run: () => void): Promise<unknown[]> {
  const rejections: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    run()
    await flushPendingRejections()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return rejections
}

const mockWriteFolderConfig = vi.mocked(writeFolderConfig)
const mockReadFolderConfig = vi.mocked(readFolderConfig)

function makeCtx(testDb: TestDatabaseResult): ApplyContext {
  return {
    db: testDb.db as unknown as DrizzleDb,
    emit: vi.fn()
  }
}

describe('folderConfigHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
    vi.clearAllMocks()
    mockReadFolderConfig.mockResolvedValue(null)
  })

  afterEach(() => {
    testDb.close()
  })

  describe('applyUpsert', () => {
    it('#given no existing row #when remote upsert arrives #then inserts DB row and writes .folder.md', async () => {
      const data: FolderConfigSyncPayload = {
        icon: '🎉',
        createdAt: '2026-04-11T00:00:00.000Z',
        modifiedAt: '2026-04-11T00:00:00.000Z'
      }
      const clock: VectorClock = { 'device-B': 1 }

      const result = folderConfigHandler.applyUpsert(ctx, 'projects/active', data, clock)

      expect(result).toBe('applied')

      const row = testDb.db
        .select()
        .from(folderConfigs)
        .where(eq(folderConfigs.path, 'projects/active'))
        .get()
      expect(row).toBeDefined()
      expect(row!.icon).toBe('🎉')
      expect(row!.clock).toEqual({ 'device-B': 1 })

      await vi.waitFor(() => {
        expect(mockWriteFolderConfig).toHaveBeenCalledWith('projects/active', { icon: '🎉' })
      })
      expect(ctx.emit as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'notes:folder-config-updated',
        { path: 'projects/active' }
      )
    })

    it('#given .folder.md has views #when remote upsert arrives #then preserves views and updates icon only', async () => {
      testDb.db
        .insert(folderConfigs)
        .values({
          path: 'docs',
          icon: '📄',
          clock: { 'device-A': 1 },
          createdAt: '2026-04-10T00:00:00.000Z',
          modifiedAt: '2026-04-10T00:00:00.000Z'
        })
        .run()

      const views = [{ name: 'All', type: 'table' as const, default: true }]
      mockReadFolderConfig.mockResolvedValue({
        icon: '📄',
        template: 'tpl-1',
        views,
        formulas: { total: 'wordCount * 2' }
      })

      const data: FolderConfigSyncPayload = { icon: '📚' }
      const clock: VectorClock = { 'device-A': 1, 'device-B': 2 }

      const result = folderConfigHandler.applyUpsert(ctx, 'docs', data, clock)

      expect(result).toBe('applied')
      await vi.waitFor(() => {
        expect(mockWriteFolderConfig).toHaveBeenCalledWith('docs', {
          icon: '📚',
          template: 'tpl-1',
          views,
          formulas: { total: 'wordCount * 2' }
        })
      })
    })

    it('#given existing row #when remote clock is newer #then updates DB row', () => {
      testDb.db
        .insert(folderConfigs)
        .values({
          path: 'docs',
          icon: '📄',
          clock: { 'device-A': 1 },
          createdAt: '2026-04-10T00:00:00.000Z',
          modifiedAt: '2026-04-10T00:00:00.000Z'
        })
        .run()

      const data: FolderConfigSyncPayload = {
        icon: '📚',
        modifiedAt: '2026-04-11T00:00:00.000Z'
      }
      const clock: VectorClock = { 'device-A': 1, 'device-B': 2 }

      const result = folderConfigHandler.applyUpsert(ctx, 'docs', data, clock)

      expect(result).toBe('applied')

      const row = testDb.db.select().from(folderConfigs).where(eq(folderConfigs.path, 'docs')).get()
      expect(row!.icon).toBe('📚')
      expect(row!.clock).toEqual({ 'device-A': 1, 'device-B': 2 })
    })

    it('#given existing row #when local clock is newer #then skips update', () => {
      testDb.db
        .insert(folderConfigs)
        .values({
          path: 'docs',
          icon: '📄',
          clock: { 'device-A': 5 },
          createdAt: '2026-04-10T00:00:00.000Z',
          modifiedAt: '2026-04-10T00:00:00.000Z'
        })
        .run()

      const data: FolderConfigSyncPayload = { icon: '📚' }
      const clock: VectorClock = { 'device-A': 2 }

      const result = folderConfigHandler.applyUpsert(ctx, 'docs', data, clock)

      expect(result).toBe('skipped')

      const row = testDb.db.select().from(folderConfigs).where(eq(folderConfigs.path, 'docs')).get()
      expect(row!.icon).toBe('📄')
      expect(mockWriteFolderConfig).not.toHaveBeenCalled()
    })

    it('#given existing row #when concurrent clocks #then merges and applies remote (LWW)', () => {
      testDb.db
        .insert(folderConfigs)
        .values({
          path: 'docs',
          icon: '📄',
          clock: { 'device-A': 2 },
          createdAt: '2026-04-10T00:00:00.000Z',
          modifiedAt: '2026-04-10T00:00:00.000Z'
        })
        .run()

      const data: FolderConfigSyncPayload = { icon: '🔥' }
      const clock: VectorClock = { 'device-B': 3 }

      const result = folderConfigHandler.applyUpsert(ctx, 'docs', data, clock)

      expect(result).toBe('conflict')

      const row = testDb.db.select().from(folderConfigs).where(eq(folderConfigs.path, 'docs')).get()
      expect(row!.icon).toBe('🔥')
      expect(row!.clock).toEqual({ 'device-A': 2, 'device-B': 3 })
    })
  })

  // The .folder.md mirror is fire-and-forget, so a rejection there used to
  // escape as an unhandled rejection in the main process — reachable in
  // production whenever a folder_config lands while the vault is closed or
  // mid-close (quit, vault switch, sign-out).
  describe('vault mirror failures', () => {
    it('#given no vault is open #when remote upsert arrives #then applies the DB row without an unhandled rejection', async () => {
      mockReadFolderConfig.mockRejectedValue(
        new VaultError('No vault is currently open', VaultErrorCode.NOT_INITIALIZED)
      )

      let result: string | undefined
      const rejections = await captureUnhandledRejections(() => {
        result = folderConfigHandler.applyUpsert(ctx, 'docs', { icon: '📁' }, { 'device-B': 1 })
      })

      expect(result).toBe('applied')
      expect(rejections).toEqual([])

      const row = testDb.db.select().from(folderConfigs).where(eq(folderConfigs.path, 'docs')).get()
      expect(row!.icon).toBe('📁')
      expect(ctx.emit as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'notes:folder-config-updated',
        { path: 'docs' }
      )
      expect(logger.warn).toHaveBeenCalledWith(
        'Skipped folder config file write, no vault is open',
        { itemId: 'docs' }
      )
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('#given no vault is open #when remote delete arrives #then removes the DB row without an unhandled rejection', async () => {
      testDb.db
        .insert(folderConfigs)
        .values({
          path: 'old-folder',
          icon: '📁',
          clock: { 'device-A': 1 },
          createdAt: '2026-04-10T00:00:00.000Z',
          modifiedAt: '2026-04-10T00:00:00.000Z'
        })
        .run()
      mockReadFolderConfig.mockRejectedValue(
        new VaultError('No vault is currently open', VaultErrorCode.NOT_INITIALIZED)
      )

      let result: string | undefined
      const rejections = await captureUnhandledRejections(() => {
        result = folderConfigHandler.applyDelete(ctx, 'old-folder', {
          'device-A': 1,
          'device-B': 2
        })
      })

      expect(result).toBe('applied')
      expect(rejections).toEqual([])
      expect(
        testDb.db.select().from(folderConfigs).where(eq(folderConfigs.path, 'old-folder')).get()
      ).toBeUndefined()
      expect(logger.warn).toHaveBeenCalledWith(
        'Skipped folder config file write, no vault is open',
        { itemId: 'old-folder' }
      )
    })

    // Same shape as the registry emit probe: a bare data-db handle, no vault
    // ever opened, and the REAL vault/folders module behind the mock. Guards
    // the exemption removal in registry.test.ts.
    it('#given the real vault module and no vault ever opened #when remote upsert arrives #then applies and emits without an unhandled rejection', async () => {
      const actual =
        await vi.importActual<typeof import('../../vault/folders')>('../../vault/folders')
      mockReadFolderConfig.mockImplementation(actual.readFolderConfig)
      mockWriteFolderConfig.mockImplementation(actual.writeFolderConfig)

      let result: string | undefined
      const rejections = await captureUnhandledRejections(() => {
        result = folderConfigHandler.applyUpsert(
          ctx,
          'folder_config-registry-probe',
          { icon: null },
          { 'device-remote': 1 }
        )
      })

      expect(result).toBe('applied')
      expect(rejections).toEqual([])
      expect(ctx.emit as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'notes:folder-config-updated',
        { path: 'folder_config-registry-probe' }
      )
      expect(logger.warn).toHaveBeenCalledWith(
        'Skipped folder config file write, no vault is open',
        { itemId: 'folder_config-registry-probe' }
      )
    })

    it('#given the .folder.md write fails #when remote upsert arrives #then logs at error with the itemId instead of throwing', async () => {
      const writeError = new Error('EACCES: permission denied')
      mockWriteFolderConfig.mockRejectedValue(writeError)

      let result: string | undefined
      const rejections = await captureUnhandledRejections(() => {
        result = folderConfigHandler.applyUpsert(ctx, 'docs', { icon: '📁' }, { 'device-B': 1 })
      })

      expect(result).toBe('applied')
      expect(rejections).toEqual([])
      expect(logger.error).toHaveBeenCalledWith('Failed to write synced folder config file', {
        itemId: 'docs',
        error: writeError
      })
      // A genuine write failure must not be downgraded to the benign no-vault path.
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })

  describe('applyDelete', () => {
    it('#given existing row #when delete arrives #then removes DB row and writes empty config', async () => {
      testDb.db
        .insert(folderConfigs)
        .values({
          path: 'old-folder',
          icon: '📁',
          clock: { 'device-A': 1 },
          createdAt: '2026-04-10T00:00:00.000Z',
          modifiedAt: '2026-04-10T00:00:00.000Z'
        })
        .run()

      const result = folderConfigHandler.applyDelete(ctx, 'old-folder', {
        'device-A': 1,
        'device-B': 2
      })

      expect(result).toBe('applied')

      const row = testDb.db
        .select()
        .from(folderConfigs)
        .where(eq(folderConfigs.path, 'old-folder'))
        .get()
      expect(row).toBeUndefined()

      await vi.waitFor(() => {
        expect(mockWriteFolderConfig).toHaveBeenCalledWith('old-folder', { icon: null })
      })
      expect(ctx.emit as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'notes:folder-config-updated',
        { path: 'old-folder' }
      )
    })

    it('#given .folder.md has views #when delete arrives #then clears icon but preserves views', async () => {
      testDb.db
        .insert(folderConfigs)
        .values({
          path: 'old-folder',
          icon: '📁',
          clock: { 'device-A': 1 },
          createdAt: '2026-04-10T00:00:00.000Z',
          modifiedAt: '2026-04-10T00:00:00.000Z'
        })
        .run()

      const views = [{ name: 'By status', type: 'table' as const }]
      mockReadFolderConfig.mockResolvedValue({ icon: '📁', views })

      const result = folderConfigHandler.applyDelete(ctx, 'old-folder', {
        'device-A': 1,
        'device-B': 2
      })

      expect(result).toBe('applied')
      await vi.waitFor(() => {
        expect(mockWriteFolderConfig).toHaveBeenCalledWith('old-folder', { icon: null, views })
      })
    })

    it('#given no existing row #when delete arrives #then skips', () => {
      const result = folderConfigHandler.applyDelete(ctx, 'nonexistent')
      expect(result).toBe('skipped')
    })

    it('#given existing row #when local clock is newer #then skips delete', () => {
      testDb.db
        .insert(folderConfigs)
        .values({
          path: 'docs',
          icon: '📄',
          clock: { 'device-A': 5 },
          createdAt: '2026-04-10T00:00:00.000Z',
          modifiedAt: '2026-04-10T00:00:00.000Z'
        })
        .run()

      const result = folderConfigHandler.applyDelete(ctx, 'docs', { 'device-A': 2 })

      expect(result).toBe('skipped')

      const row = testDb.db.select().from(folderConfigs).where(eq(folderConfigs.path, 'docs')).get()
      expect(row).toBeDefined()
    })
  })

  describe('fetchLocal', () => {
    it('#given existing row #when fetched #then returns row as record', () => {
      testDb.db
        .insert(folderConfigs)
        .values({
          path: 'docs',
          icon: '📄',
          clock: { 'device-A': 1 },
          createdAt: '2026-04-10T00:00:00.000Z',
          modifiedAt: '2026-04-10T00:00:00.000Z'
        })
        .run()

      const result = folderConfigHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'docs')

      expect(result).toBeDefined()
      expect(result!.icon).toBe('📄')
    })

    it('#given no row #when fetched #then returns undefined', () => {
      const result = folderConfigHandler.fetchLocal(
        testDb.db as unknown as DrizzleDb,
        'nonexistent'
      )
      expect(result).toBeUndefined()
    })
  })

  describe('buildPushPayload', () => {
    it('#given existing row #when building payload #then returns serialized JSON', () => {
      testDb.db
        .insert(folderConfigs)
        .values({
          path: 'docs',
          icon: '📄',
          clock: { 'device-A': 1 },
          createdAt: '2026-04-10T00:00:00.000Z',
          modifiedAt: '2026-04-10T00:00:00.000Z'
        })
        .run()

      const payload = folderConfigHandler.buildPushPayload!(
        testDb.db as unknown as DrizzleDb,
        'docs',
        'device-A',
        'update'
      )

      expect(payload).not.toBeNull()
      const parsed = JSON.parse(payload!)
      expect(parsed.icon).toBe('📄')
      expect(parsed.clock).toEqual({ 'device-A': 1 })
      expect(parsed.createdAt).toBe('2026-04-10T00:00:00.000Z')
    })

    it('#given no row #when building payload #then returns null', () => {
      const payload = folderConfigHandler.buildPushPayload!(
        testDb.db as unknown as DrizzleDb,
        'nonexistent',
        'device-A',
        'update'
      )
      expect(payload).toBeNull()
    })
  })

  describe('seedUnclocked', () => {
    it('#given folder configs with no clock #when seeding #then assigns clocks and enqueues', () => {
      testDb.db
        .insert(folderConfigs)
        .values([
          {
            path: 'docs',
            icon: '📄',
            createdAt: '2026-04-10T00:00:00.000Z',
            modifiedAt: '2026-04-10T00:00:00.000Z'
          },
          {
            path: 'projects',
            icon: '🚀',
            createdAt: '2026-04-10T00:00:00.000Z',
            modifiedAt: '2026-04-10T00:00:00.000Z'
          }
        ])
        .run()

      const { mock: mockQueue, queue } = makeMockQueue()

      const count = folderConfigHandler.seedUnclocked(
        testDb.db as unknown as DrizzleDb,
        'device-A',
        queue
      )

      expect(count).toBe(2)

      const docs = testDb.db
        .select()
        .from(folderConfigs)
        .where(eq(folderConfigs.path, 'docs'))
        .get()
      expect(docs!.clock).toEqual({ 'device-A': 1 })

      expect(mockQueue.enqueue).toHaveBeenCalledTimes(2)
      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'folder_config',
          itemId: 'docs',
          operation: 'create'
        })
      )
    })

    it('#given no unclocked rows #when seeding #then returns 0', () => {
      testDb.db
        .insert(folderConfigs)
        .values({
          path: 'docs',
          icon: '📄',
          clock: { 'device-A': 1 },
          createdAt: '2026-04-10T00:00:00.000Z',
          modifiedAt: '2026-04-10T00:00:00.000Z'
        })
        .run()

      const { mock: mockQueue, queue } = makeMockQueue()

      const count = folderConfigHandler.seedUnclocked(
        testDb.db as unknown as DrizzleDb,
        'device-A',
        queue
      )

      expect(count).toBe(0)
      expect(mockQueue.enqueue).not.toHaveBeenCalled()
    })
  })
})
