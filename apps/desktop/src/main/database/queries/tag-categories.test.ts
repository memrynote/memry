import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import {
  listTagCategories,
  createTagCategory,
  renameTagCategory,
  deleteTagCategory,
  reorderTags,
  reorderCategories
} from './tag-categories'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'
import { getOrCreateTag } from './tag-definitions'

let db: TestDataDb

beforeEach(() => {
  db = createTestDataDb()
})

describe('tag categories', () => {
  it('creates a category and appends it at the end', () => {
    const work = createTagCategory(db, 'Work')
    const books = createTagCategory(db, 'Books')

    expect(work.sortOrder).toBe(0)
    expect(books.sortOrder).toBe(1)
    expect(listTagCategories(db).map((c) => c.name)).toEqual(['Work', 'Books'])
  })

  it('counts the tags in each category', () => {
    const work = createTagCategory(db, 'Work')
    getOrCreateTag(db, 'meetings')
    getOrCreateTag(db, 'okr')
    getOrCreateTag(db, 'idea')
    reorderTags(db, [
      { tag: 'meetings', categoryId: work.id, sortOrder: 0 },
      { tag: 'okr', categoryId: work.id, sortOrder: 1 }
    ])

    expect(listTagCategories(db)[0].tagCount).toBe(2)
  })

  it('renames a category', () => {
    const c = createTagCategory(db, 'Work')
    renameTagCategory(db, c.id, 'Job')
    expect(listTagCategories(db)[0].name).toBe('Job')
  })

  it('deleting a category keeps its tags and uncategorizes them', () => {
    const work = createTagCategory(db, 'Work')
    getOrCreateTag(db, 'meetings')
    reorderTags(db, [{ tag: 'meetings', categoryId: work.id, sortOrder: 7 }])

    const before = db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'meetings')).get()
    const rowCountBefore = db.select().from(tagDefinitions).all().length

    deleteTagCategory(db, work.id)

    expect(listTagCategories(db)).toEqual([])

    const after = db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'meetings')).get()

    // Query tag_definitions directly (not via getOrCreateTag, which is get-or-insert
    // and would silently recreate a deleted row) to prove the tag row itself survives
    // the category deletion rather than being hard-deleted.
    expect(after).toBeDefined()
    expect(after?.categoryId).toBeNull()
    expect(after?.sortOrder).toBe(7)
    expect(after?.color).toBe(before?.color)
    expect(after?.createdAt).toBe(before?.createdAt)
    expect(db.select().from(tagDefinitions).all().length).toBe(rowCountBefore)
  })

  it('moves a tag between categories in one call', () => {
    const work = createTagCategory(db, 'Work')
    const books = createTagCategory(db, 'Books')
    getOrCreateTag(db, 'notes')
    reorderTags(db, [{ tag: 'notes', categoryId: work.id, sortOrder: 0 }])

    reorderTags(db, [{ tag: 'notes', categoryId: books.id, sortOrder: 0 }])

    const [w, b] = listTagCategories(db)
    expect(w.tagCount).toBe(0)
    expect(b.tagCount).toBe(1)
  })

  it('reorders categories', () => {
    const work = createTagCategory(db, 'Work')
    const books = createTagCategory(db, 'Books')

    reorderCategories(db, [
      { id: books.id, sortOrder: 0 },
      { id: work.id, sortOrder: 1 }
    ])

    expect(listTagCategories(db).map((c) => c.name)).toEqual(['Books', 'Work'])
  })

  it('normalizes tag names when assigning', () => {
    const work = createTagCategory(db, 'Work')
    getOrCreateTag(db, 'meetings')
    reorderTags(db, [{ tag: '  MEETINGS ', categoryId: work.id, sortOrder: 0 }])
    expect(listTagCategories(db)[0].tagCount).toBe(1)
  })
})
