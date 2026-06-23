import { asc, eq } from 'drizzle-orm'
import {
  homePages,
  type HomePageRow,
  type NewHomePageRow
} from '@memry/db-schema/schema/home-pages'
import type { DataDb } from '../types'

export function listHomePages(db: DataDb): HomePageRow[] {
  return db.select().from(homePages).orderBy(asc(homePages.position)).all()
}

export function getHomePage(db: DataDb, id: string): HomePageRow | undefined {
  return db.select().from(homePages).where(eq(homePages.id, id)).get()
}

export function insertHomePage(db: DataDb, row: NewHomePageRow): HomePageRow {
  return db.insert(homePages).values(row).returning().get()
}

export function updateHomePage(
  db: DataDb,
  id: string,
  patch: Partial<Pick<NewHomePageRow, 'name' | 'icon' | 'position' | 'widgets'>>
): HomePageRow | undefined {
  return db
    .update(homePages)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(homePages.id, id))
    .returning()
    .get()
}

export function deleteHomePage(db: DataDb, id: string): boolean {
  return db.delete(homePages).where(eq(homePages.id, id)).run().changes > 0
}

export function reorderHomePages(db: DataDb, ids: string[]): void {
  db.transaction((tx) => {
    ids.forEach((id, position) => {
      tx.update(homePages).set({ position }).where(eq(homePages.id, id)).run()
    })
  })
}
