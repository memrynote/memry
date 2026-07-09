import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { customThemes } from '@memry/db-schema/schema/custom-themes'
import type { ThemeSyncPayload } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import type { ApplyContext, DrizzleDb } from './types'

type MockQueue = Pick<SyncQueueManager, 'enqueue'> & { enqueue: ReturnType<typeof vi.fn> }

function makeMockQueue(): { mock: MockQueue; queue: SyncQueueManager } {
  const mock: MockQueue = { enqueue: vi.fn() }
  return { mock, queue: mock as unknown as SyncQueueManager }
}

vi.mock('./theme-file-effects', () => ({
  applyThemeFile: vi.fn(),
  removeThemeFile: vi.fn()
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { themeHandler } from './theme-handler'
import { applyThemeFile, removeThemeFile } from './theme-file-effects'

const mockApplyThemeFile = vi.mocked(applyThemeFile)
const mockRemoveThemeFile = vi.mocked(removeThemeFile)

function makeCtx(testDb: TestDatabaseResult): ApplyContext {
  return {
    db: testDb.db as unknown as DrizzleDb,
    emit: vi.fn()
  }
}

const basePayload: ThemeSyncPayload = {
  name: 'Tema 1',
  slug: 'tema-1',
  base: 'dark',
  variables: { '--background': '#101010' },
  createdAt: '2026-07-09T10:00:00.000Z',
  modifiedAt: '2026-07-09T10:00:00.000Z'
}

function insertRow(testDb: TestDatabaseResult, overrides: Record<string, unknown> = {}): void {
  testDb.db
    .insert(customThemes)
    .values({
      id: 'theme-1',
      name: 'Tema 1',
      slug: 'tema-1',
      base: 'dark',
      variables: { '--background': '#101010' },
      clock: { 'device-A': 1 },
      createdAt: '2026-07-09T10:00:00.000Z',
      modifiedAt: '2026-07-09T10:00:00.000Z',
      ...overrides
    })
    .run()
}

describe('themeHandler', () => {
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
    it('#given no existing row #when remote upsert arrives #then inserts row and writes file', () => {
      const clock: VectorClock = { 'device-B': 1 }

      const result = themeHandler.applyUpsert(ctx, 'theme-1', basePayload, clock)

      expect(result).toBe('applied')
      const row = testDb.db.select().from(customThemes).where(eq(customThemes.id, 'theme-1')).get()
      expect(row).toBeDefined()
      expect(row!.slug).toBe('tema-1')
      expect(row!.variables).toEqual({ '--background': '#101010' })
      expect(row!.clock).toEqual({ 'device-B': 1 })
      expect(mockApplyThemeFile).toHaveBeenCalledWith(
        'tema-1',
        expect.objectContaining({ id: 'theme-1', name: 'Tema 1', base: 'dark' })
      )
      expect(ctx.emit as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('themes:updated', {
        id: 'theme-1'
      })
    })

    it('#given remote payload with invalid variables #then sanitizes before storing', () => {
      const result = themeHandler.applyUpsert(
        ctx,
        'theme-1',
        {
          ...basePayload,
          variables: { '--background': '#101010', '--bad': 'red', nope: '#123456' }
        },
        { 'device-B': 1 }
      )

      expect(result).toBe('applied')
      const row = testDb.db.select().from(customThemes).where(eq(customThemes.id, 'theme-1')).get()
      expect(row!.variables).toEqual({ '--background': '#101010' })
    })

    it('#given existing row #when remote clock newer #then updates and renames file on slug change', () => {
      insertRow(testDb)

      const result = themeHandler.applyUpsert(
        ctx,
        'theme-1',
        { ...basePayload, name: 'Renamed', slug: 'renamed' },
        { 'device-A': 1, 'device-B': 2 }
      )

      expect(result).toBe('applied')
      const row = testDb.db.select().from(customThemes).where(eq(customThemes.id, 'theme-1')).get()
      expect(row!.slug).toBe('renamed')
      expect(mockApplyThemeFile).toHaveBeenCalledWith(
        'renamed',
        expect.objectContaining({ name: 'Renamed' }),
        'tema-1'
      )
    })

    it('#given existing row #when local clock newer #then skips', () => {
      insertRow(testDb, { clock: { 'device-A': 5 } })

      const result = themeHandler.applyUpsert(
        ctx,
        'theme-1',
        { ...basePayload, name: 'Stale' },
        { 'device-A': 2 }
      )

      expect(result).toBe('skipped')
      const row = testDb.db.select().from(customThemes).where(eq(customThemes.id, 'theme-1')).get()
      expect(row!.name).toBe('Tema 1')
      expect(mockApplyThemeFile).not.toHaveBeenCalled()
    })

    it('#given concurrent clocks #then merges clocks and applies remote (LWW conflict)', () => {
      insertRow(testDb, { clock: { 'device-A': 2 } })

      const result = themeHandler.applyUpsert(
        ctx,
        'theme-1',
        { ...basePayload, name: 'Remote wins' },
        { 'device-B': 3 }
      )

      expect(result).toBe('conflict')
      const row = testDb.db.select().from(customThemes).where(eq(customThemes.id, 'theme-1')).get()
      expect(row!.name).toBe('Remote wins')
      expect(row!.clock).toEqual({ 'device-A': 2, 'device-B': 3 })
    })
  })

  describe('applyDelete', () => {
    it('#given existing row #when delete arrives #then removes row and file', () => {
      insertRow(testDb)

      const result = themeHandler.applyDelete(ctx, 'theme-1', { 'device-A': 1, 'device-B': 2 })

      expect(result).toBe('applied')
      const row = testDb.db.select().from(customThemes).where(eq(customThemes.id, 'theme-1')).get()
      expect(row).toBeUndefined()
      expect(mockRemoveThemeFile).toHaveBeenCalledWith('tema-1')
      expect(ctx.emit as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('themes:deleted', {
        id: 'theme-1'
      })
    })

    it('#given no row #when delete arrives #then skips', () => {
      expect(themeHandler.applyDelete(ctx, 'nope')).toBe('skipped')
    })

    it('#given local clock newer #when delete arrives #then skips delete', () => {
      insertRow(testDb, { clock: { 'device-A': 5 } })

      const result = themeHandler.applyDelete(ctx, 'theme-1', { 'device-A': 2 })

      expect(result).toBe('skipped')
      expect(
        testDb.db.select().from(customThemes).where(eq(customThemes.id, 'theme-1')).get()
      ).toBeDefined()
    })
  })

  describe('buildPushPayload', () => {
    it('#given existing row #then serializes name/slug/base/variables/clock', () => {
      insertRow(testDb)

      const payload = themeHandler.buildPushPayload!(
        testDb.db as unknown as DrizzleDb,
        'theme-1',
        'device-A',
        'update'
      )

      expect(payload).not.toBeNull()
      const parsed = JSON.parse(payload!)
      expect(parsed).toMatchObject({
        name: 'Tema 1',
        slug: 'tema-1',
        base: 'dark',
        variables: { '--background': '#101010' },
        clock: { 'device-A': 1 }
      })
    })

    it('#given no row #then returns null', () => {
      expect(
        themeHandler.buildPushPayload!(
          testDb.db as unknown as DrizzleDb,
          'nope',
          'device-A',
          'update'
        )
      ).toBeNull()
    })
  })

  describe('seedUnclocked', () => {
    it('#given unclocked rows #then assigns clocks and enqueues creates', () => {
      insertRow(testDb, { clock: null })
      const { mock, queue } = makeMockQueue()

      const count = themeHandler.seedUnclocked(testDb.db as unknown as DrizzleDb, 'device-A', queue)

      expect(count).toBe(1)
      const row = testDb.db.select().from(customThemes).where(eq(customThemes.id, 'theme-1')).get()
      expect(row!.clock).toEqual({ 'device-A': 1 })
      expect(mock.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'theme', itemId: 'theme-1', operation: 'create' })
      )
    })

    it('#given only clocked rows #then returns 0', () => {
      insertRow(testDb)
      const { mock, queue } = makeMockQueue()

      expect(themeHandler.seedUnclocked(testDb.db as unknown as DrizzleDb, 'device-A', queue)).toBe(
        0
      )
      expect(mock.enqueue).not.toHaveBeenCalled()
    })
  })
})
