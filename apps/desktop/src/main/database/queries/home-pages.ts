import { asc, eq } from 'drizzle-orm'
import {
  homePages,
  type HomePageRow,
  type NewHomePageRow
} from '@memry/db-schema/schema/home-pages'
import type { DataDb } from '../types'

/**
 * Ordered by `position`, then `createdAt`, then `id`.
 *
 * The tiebreak is load-bearing now that boards sync: concurrent creates on two
 * devices both take `position: boards.length`, and SQLite returns ties in rowid
 * order, which differs per device. Without it the board dropdown — and
 * `boards[0]`, the active-board fallback — would visibly differ machine to
 * machine. `createdAt` is carried verbatim in the sync payload so the tiebreak
 * is byte-identical everywhere.
 */
export function listHomePages(db: DataDb): HomePageRow[] {
  return db
    .select()
    .from(homePages)
    .orderBy(asc(homePages.position), asc(homePages.createdAt), asc(homePages.id))
    .all()
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

/**
 * Returns the ids whose `position` actually changed, and bumps `updatedAt` on
 * only those rows. The caller enqueues one sync update per returned id — a
 * one-slot move must not push every board on the account.
 */
export function reorderHomePages(db: DataDb, ids: string[]): string[] {
  return db.transaction((tx) => {
    const now = new Date().toISOString()
    const changed: string[] = []
    ids.forEach((id, position) => {
      const existing = tx.select().from(homePages).where(eq(homePages.id, id)).get()
      if (!existing || existing.position === position) return
      tx.update(homePages).set({ position, updatedAt: now }).where(eq(homePages.id, id)).run()
      changed.push(id)
    })
    return changed
  })
}
