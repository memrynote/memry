import { describe, it, expect, beforeEach, vi } from 'vitest'
import { tagCategories } from '@memry/db-schema/schema/tag-categories'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { tagCategoryHandler } from './tag-category-handler'

let db: TestDataDb
const emit = vi.fn()
const ctx = () => ({ db, emit })

beforeEach(() => {
  db = createTestDataDb()
  emit.mockClear()
})

describe('tagCategoryHandler', () => {
  it('inserts a category that does not exist locally', () => {
    const result = tagCategoryHandler.applyUpsert(
      ctx(),
      'cat-1',
      { name: 'Work', sortOrder: 2 },
      { deviceA: 1 }
    )

    expect(result).toBe('applied')
    const row = db.select().from(tagCategories).where(eq(tagCategories.id, 'cat-1')).get()
    expect(row?.name).toBe('Work')
    expect(row?.sortOrder).toBe(2)
    expect(emit).toHaveBeenCalledWith('tags:categories-changed', expect.anything())
  })

  it('skips a remote update when the local clock is strictly newer', () => {
    tagCategoryHandler.applyUpsert(ctx(), 'cat-1', { name: 'Work', sortOrder: 0 }, { deviceA: 5 })

    const result = tagCategoryHandler.applyUpsert(
      ctx(),
      'cat-1',
      { name: 'Stale', sortOrder: 9 },
      { deviceA: 2 }
    )

    expect(result).toBe('skipped')
    const row = db.select().from(tagCategories).where(eq(tagCategories.id, 'cat-1')).get()
    expect(row?.name).toBe('Work')
  })

  it('reports a conflict on concurrent edits and keeps the remote value', () => {
    tagCategoryHandler.applyUpsert(ctx(), 'cat-1', { name: 'Work', sortOrder: 0 }, { deviceA: 3 })

    const result = tagCategoryHandler.applyUpsert(
      ctx(),
      'cat-1',
      { name: 'Job', sortOrder: 1 },
      { deviceB: 4 }
    )

    expect(result).toBe('conflict')
    const row = db.select().from(tagCategories).where(eq(tagCategories.id, 'cat-1')).get()
    expect(row?.name).toBe('Job')
  })

  it('soft-deletes on delete rather than dropping the row', () => {
    tagCategoryHandler.applyUpsert(ctx(), 'cat-1', { name: 'Work', sortOrder: 0 }, { deviceA: 1 })

    const result = tagCategoryHandler.applyDelete(ctx(), 'cat-1', { deviceA: 2 })

    expect(result).toBe('applied')
    const row = db.select().from(tagCategories).where(eq(tagCategories.id, 'cat-1')).get()
    expect(row?.deletedAt).toBeTruthy()
  })

  it('builds a push payload that round-trips through the schema', () => {
    tagCategoryHandler.applyUpsert(ctx(), 'cat-1', { name: 'Work', sortOrder: 4 }, { deviceA: 1 })

    const json = tagCategoryHandler.buildPushPayload(db, 'cat-1', 'deviceA', 'update')

    expect(json).not.toBeNull()
    expect(JSON.parse(json!)).toMatchObject({ name: 'Work', sortOrder: 4 })
  })
})
