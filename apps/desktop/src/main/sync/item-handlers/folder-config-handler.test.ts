import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import type { FolderConfigSyncPayload } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { ApplyContext, DrizzleDb } from './types'

vi.mock('../../vault/folders', () => ({
  writeFolderConfig: vi.fn(),
  readFolderConfig: vi.fn()
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { folderConfigHandler } from './folder-config-handler'
import { writeFolderConfig, readFolderConfig } from '../../vault/folders'

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
  })

  afterEach(() => {
    testDb.close()
  })

  describe('applyUpsert', () => {
    it('#given no existing row #when remote upsert arrives #then inserts DB row and writes .folder.md', () => {
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

      expect(mockWriteFolderConfig).toHaveBeenCalledWith('projects/active', { icon: '🎉' })
      expect(ctx.emit as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'notes:folder-config-updated',
        { path: 'projects/active' }
      )
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

  describe('applyDelete', () => {
    it('#given existing row #when delete arrives #then removes DB row and writes empty config', () => {
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

      expect(mockWriteFolderConfig).toHaveBeenCalledWith('old-folder', { icon: null })
      expect(ctx.emit as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'notes:folder-config-updated',
        { path: 'old-folder' }
      )
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

      const mockQueue = { enqueue: vi.fn() }

      const count = folderConfigHandler.seedUnclocked(
        testDb.db as unknown as DrizzleDb,
        'device-A',
        mockQueue as any
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

      const mockQueue = { enqueue: vi.fn() }

      const count = folderConfigHandler.seedUnclocked(
        testDb.db as unknown as DrizzleDb,
        'device-A',
        mockQueue as any
      )

      expect(count).toBe(0)
      expect(mockQueue.enqueue).not.toHaveBeenCalled()
    })
  })
})
