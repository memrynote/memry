import { and, asc, eq } from 'drizzle-orm'
import { bookmarks } from '@memry/db-schema/data-schema'
import { bookmarkSyncId } from '@memry/contracts/bookmark-types'
import type { DataDb } from './database.ts'

export interface BookmarkRecord {
  id: string
  itemType: string
  itemId: string
  position: number
  createdAt: string
}

export interface CreateBookmarkInput {
  itemType: string
  itemId: string
  position?: number
}

export interface BookmarksService {
  list(options?: { itemType?: string }): Promise<BookmarkRecord[]>
  get(id: string): Promise<BookmarkRecord | null>
  getByItem(itemType: string, itemId: string): Promise<BookmarkRecord | null>
  add(input: CreateBookmarkInput): Promise<BookmarkRecord>
  delete(id: string): Promise<boolean>
  remove(itemType: string, itemId: string): Promise<boolean>
  has(itemType: string, itemId: string): Promise<boolean>
  toggle(
    input: CreateBookmarkInput
  ): Promise<{ bookmarked: boolean; bookmark: BookmarkRecord | null }>
  reorder(ids: string[]): Promise<BookmarkRecord[]>
  bulkCreate(items: CreateBookmarkInput[]): Promise<BookmarkRecord[]>
  bulkDelete(ids: string[]): Promise<boolean>
}

function nowIso(): string {
  return new Date().toISOString()
}

function toBookmark(row: typeof bookmarks.$inferSelect): BookmarkRecord {
  return {
    id: row.id,
    itemType: row.itemType,
    itemId: row.itemId,
    position: row.position,
    createdAt: row.createdAt
  }
}

function whereItem(itemType: string, itemId: string) {
  return and(eq(bookmarks.itemType, itemType), eq(bookmarks.itemId, itemId))
}

function nextPosition(db: DataDb): number {
  const rows = db.select().from(bookmarks).all()
  return rows.reduce((max, bookmark) => Math.max(max, bookmark.position), -1) + 1
}

export function createBookmarksService(dataDb: DataDb): BookmarksService {
  return {
    async list(options = {}) {
      const rows = dataDb.select().from(bookmarks).orderBy(asc(bookmarks.position)).all()
      return rows
        .filter((bookmark) => !options.itemType || bookmark.itemType === options.itemType)
        .map(toBookmark)
    },

    async get(id) {
      const row = dataDb.select().from(bookmarks).where(eq(bookmarks.id, id)).get()
      return row ? toBookmark(row) : null
    },

    async getByItem(itemType, itemId) {
      const row = dataDb.select().from(bookmarks).where(whereItem(itemType, itemId)).get()
      return row ? toBookmark(row) : null
    },

    async add(input) {
      const itemType = input.itemType.trim()
      const itemId = input.itemId.trim()
      if (!itemType) throw new Error('Bookmark item type is required')
      if (!itemId) throw new Error('Bookmark item id is required')

      const existing = dataDb.select().from(bookmarks).where(whereItem(itemType, itemId)).get()
      if (existing) return toBookmark(existing)

      const id = bookmarkSyncId(itemType, itemId)
      dataDb
        .insert(bookmarks)
        .values({
          id,
          itemType,
          itemId,
          position: input.position ?? nextPosition(dataDb),
          createdAt: nowIso()
        })
        .run()

      const row = dataDb.select().from(bookmarks).where(eq(bookmarks.id, id)).get()
      if (!row) throw new Error('Bookmark not found after create')
      return toBookmark(row)
    },

    async delete(id) {
      dataDb.delete(bookmarks).where(eq(bookmarks.id, id)).run()
      return true
    },

    async remove(itemType, itemId) {
      dataDb.delete(bookmarks).where(whereItem(itemType, itemId)).run()
      return true
    },

    async has(itemType, itemId) {
      return !!dataDb.select().from(bookmarks).where(whereItem(itemType, itemId)).get()
    },

    async toggle(input) {
      const existing = await this.getByItem(input.itemType, input.itemId)
      if (existing) {
        await this.delete(existing.id)
        return { bookmarked: false, bookmark: null }
      }
      return { bookmarked: true, bookmark: await this.add(input) }
    },

    async reorder(ids) {
      ids.forEach((id, position) => {
        dataDb.update(bookmarks).set({ position }).where(eq(bookmarks.id, id)).run()
      })
      return this.list()
    },

    async bulkCreate(items) {
      const created: BookmarkRecord[] = []
      for (const item of items) created.push(await this.add(item))
      return created
    },

    async bulkDelete(ids) {
      for (const id of ids) await this.delete(id)
      return true
    }
  }
}
