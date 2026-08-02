import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { tagCategories } from '@memry/db-schema/schema/tag-categories'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { utcNow } from '@memry/shared/utc'
import type { DataDb } from '../types'

export interface TagCategoryRow {
  id: string
  name: string
  sortOrder: number
  tagCount: number
}

export interface TagAssignment {
  tag: string
  categoryId: string | null
  sortOrder: number
}

const normalize = (tag: string): string => tag.toLowerCase().trim()

export function listTagCategories(db: DataDb): TagCategoryRow[] {
  return db
    .select({
      id: tagCategories.id,
      name: tagCategories.name,
      sortOrder: tagCategories.sortOrder,
      tagCount: sql<number>`(
        SELECT COUNT(*) FROM ${tagDefinitions}
        WHERE ${tagDefinitions.categoryId} = ${tagCategories.id}
      )`
    })
    .from(tagCategories)
    .where(isNull(tagCategories.deletedAt))
    .orderBy(asc(tagCategories.sortOrder), asc(tagCategories.name))
    .all()
}

export function createTagCategory(db: DataDb, name: string): TagCategoryRow {
  const trimmed = name.trim()
  const next = db
    .select({ max: sql<number | null>`MAX(${tagCategories.sortOrder})` })
    .from(tagCategories)
    .where(isNull(tagCategories.deletedAt))
    .get()
  const sortOrder = (next?.max ?? -1) + 1
  const id = randomUUID()
  const now = utcNow()

  db.insert(tagCategories)
    .values({ id, name: trimmed, sortOrder, clock: null, createdAt: now, updatedAt: now })
    .run()

  return { id, name: trimmed, sortOrder, tagCount: 0 }
}

export function renameTagCategory(db: DataDb, id: string, name: string): void {
  db.update(tagCategories)
    .set({ name: name.trim(), updatedAt: utcNow() })
    .where(eq(tagCategories.id, id))
    .run()
}

export function deleteTagCategory(db: DataDb, id: string): void {
  db.transaction((tx) => {
    tx.update(tagDefinitions)
      .set({ categoryId: null })
      .where(eq(tagDefinitions.categoryId, id))
      .run()
    tx.update(tagCategories)
      .set({ deletedAt: utcNow(), updatedAt: utcNow() })
      .where(eq(tagCategories.id, id))
      .run()
  })
}

export function reorderTags(db: DataDb, assignments: TagAssignment[]): void {
  db.transaction((tx) => {
    for (const a of assignments) {
      tx.update(tagDefinitions)
        .set({ categoryId: a.categoryId, sortOrder: a.sortOrder })
        .where(eq(tagDefinitions.name, normalize(a.tag)))
        .run()
    }
  })
}

export function reorderCategories(db: DataDb, order: { id: string; sortOrder: number }[]): void {
  const now = utcNow()
  db.transaction((tx) => {
    for (const o of order) {
      tx.update(tagCategories)
        .set({ sortOrder: o.sortOrder, updatedAt: now })
        .where(and(eq(tagCategories.id, o.id), isNull(tagCategories.deletedAt)))
        .run()
    }
  })
}
