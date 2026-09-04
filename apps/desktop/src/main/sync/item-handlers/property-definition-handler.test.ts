import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { propertyDefinitions } from '@memry/db-schema/schema/notes-cache'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { propertyDefinitionHandler } from './property-definition-handler'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../vault/property-definitions', () => ({
  PropertyDefinitionsService: { get: () => ({ applyRemoteDelete: vi.fn(async () => {}) }) }
}))

const AREA_OPTIONS = JSON.stringify([{ value: 'Work', color: 'indigo' }])

function makeCtx(testDb: TestDatabaseResult): ApplyContext {
  return { db: testDb.db as unknown as DrizzleDb, emit: vi.fn() }
}

function read(testDb: TestDatabaseResult, name: string) {
  return testDb.db
    .select()
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.name, name))
    .get()
}

describe('propertyDefinitionHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('inserts a definition it has never seen, options JSON intact', () => {
    const result = propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-b': 1 }
    )

    expect(result).toBe('applied')
    expect(read(testDb, 'area')).toMatchObject({
      name: 'area',
      type: 'select',
      options: AREA_OPTIONS,
      clock: { 'device-b': 1 }
    })
  })

  it('applies a strictly newer clock', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-b': 1 }
    )

    const next = JSON.stringify([{ value: 'Work', color: 'sky' }])
    const result = propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: next },
      { 'device-b': 2 }
    )

    expect(result).toBe('applied')
    expect(read(testDb, 'area')?.options).toBe(next)
  })

  it('skips an older clock rather than repainting the options', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-b': 3 }
    )

    const result = propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: '[]' },
      { 'device-b': 2 }
    )

    expect(result).toBe('skipped')
    expect(read(testDb, 'area')?.options).toBe(AREA_OPTIONS)
  })

  it('reports a concurrent edit as a conflict and takes the remote fields', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-a': 1 }
    )

    const result = propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: '[]' },
      { 'device-b': 1 }
    )

    expect(result).toBe('conflict')
    expect(read(testDb, 'area')?.options).toBe('[]')
    expect(read(testDb, 'area')?.clock).toEqual({ 'device-a': 1, 'device-b': 1 })
  })

  it('keeps a field the sender omitted instead of clearing it', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS, defaultValue: 'Work' },
      { 'device-b': 1 }
    )

    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-b': 2 }
    )

    // An older client that does not know `defaultValue` sends no key at all.
    // Treating that as "clear it" is how saved views were destroyed once.
    expect(read(testDb, 'area')?.defaultValue).toBe('Work')
  })

  it('honours an explicit null as a clear', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS, defaultValue: 'Work' },
      { 'device-b': 1 }
    )

    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS, defaultValue: null },
      { 'device-b': 2 }
    )

    expect(read(testDb, 'area')?.defaultValue).toBeNull()
  })

  it('deletes on a strictly newer tombstone', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-b': 1 }
    )

    expect(propertyDefinitionHandler.applyDelete(ctx, 'area', { 'device-b': 2 })).toBe('applied')
    expect(read(testDb, 'area')).toBeUndefined()
  })

  it('refuses a tombstone that has not seen the local edit', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-a': 2 }
    )

    expect(propertyDefinitionHandler.applyDelete(ctx, 'area', { 'device-b': 1 })).toBe('skipped')
    expect(read(testDb, 'area')).toBeDefined()
  })

  it('seeds every unclocked definition exactly once', () => {
    testDb.db
      .insert(propertyDefinitions)
      .values({ name: 'area', type: 'select', options: AREA_OPTIONS })
      .run()

    const queue = new SyncQueueManager(testDb.db as never)
    const seeded = propertyDefinitionHandler.seedUnclocked(
      testDb.db as unknown as DrizzleDb,
      'device-a',
      queue
    )

    expect(seeded).toBe(1)
    expect(read(testDb, 'area')?.clock).toEqual({ 'device-a': 1 })
    // Without the clock write above, every sync would re-seed the whole table.
    expect(
      propertyDefinitionHandler.seedUnclocked(testDb.db as unknown as DrizzleDb, 'device-a', queue)
    ).toBe(0)
  })
})
