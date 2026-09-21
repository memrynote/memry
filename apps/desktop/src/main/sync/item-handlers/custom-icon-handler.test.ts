import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { customIcons } from '@memry/db-schema/schema/custom-icons'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { customIconHandler } from './custom-icon-handler'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../../vault/custom-icons', () => ({
  writeCustomIconFile: vi.fn(async () => {}),
  deleteCustomIconFile: vi.fn(async () => {})
}))

describe('customIconHandler.applyDelete', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  const seed = (clock: Record<string, number> | null): void => {
    testDb.db
      .insert(customIcons)
      .values({ id: 'icon-1', name: 'Star', ext: 'png', data: 'AA==', clock })
      .run()
  }

  const row = () => testDb.db.select().from(customIcons).where(eq(customIcons.id, 'icon-1')).get()

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = { db: testDb.db as unknown as DrizzleDb, emit: vi.fn() }
  })

  afterEach(() => {
    testDb.close()
  })

  it('skips a tombstone the local row already happened after', () => {
    seed({ 'device-a': 3 })

    expect(customIconHandler.applyDelete(ctx, 'icon-1', { 'device-a': 2 })).toBe('skipped')
    expect(row()).toBeDefined()
  })

  it('applies a tombstone concurrent with the local row, because delete wins (#2198)', () => {
    seed({ 'device-a': 3 })

    expect(customIconHandler.applyDelete(ctx, 'icon-1', { 'device-b': 1 })).toBe('applied')
    expect(row()).toBeUndefined()
  })

  it('skips an unknown id', () => {
    expect(customIconHandler.applyDelete(ctx, 'missing', { 'device-a': 1 })).toBe('skipped')
  })
})
