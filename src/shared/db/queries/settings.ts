/**
 * Settings and Saved Filters query functions for Drizzle ORM.
 * These queries operate on data.db.
 *
 * @module db/queries/settings
 */

import { eq, asc, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { settings, savedFilters, type SavedFilter, type NewSavedFilter } from '../schema/settings'
import * as schema from '../schema'

type DrizzleDb = BetterSQLite3Database<typeof schema>

// ============================================================================
// Settings CRUD
// ============================================================================

/**
 * Get a setting value by key.
 */
export function getSetting(db: DrizzleDb, key: string): string | null {
  const result = db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()
  return result?.value ?? null
}

/**
 * Set a setting value.
 */
export function setSetting(db: DrizzleDb, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value, modifiedAt: sql`datetime('now')` })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, modifiedAt: sql`datetime('now')` }
    })
    .run()
}

/**
 * Delete a setting by key.
 */
export function deleteSetting(db: DrizzleDb, key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run()
}

// ============================================================================
// Saved Filters CRUD
// ============================================================================

/**
 * Insert a new saved filter.
 */
export function insertSavedFilter(db: DrizzleDb, filter: NewSavedFilter): SavedFilter {
  return db.insert(savedFilters).values(filter).returning().get()
}

/**
 * Update an existing saved filter.
 */
export function updateSavedFilter(
  db: DrizzleDb,
  id: string,
  updates: Partial<Omit<SavedFilter, 'id' | 'createdAt'>>
): SavedFilter | undefined {
  return db.update(savedFilters).set(updates).where(eq(savedFilters.id, id)).returning().get()
}

/**
 * Delete a saved filter by ID.
 */
export function deleteSavedFilter(db: DrizzleDb, id: string): void {
  db.delete(savedFilters).where(eq(savedFilters.id, id)).run()
}

/**
 * Get a saved filter by ID.
 */
export function getSavedFilterById(db: DrizzleDb, id: string): SavedFilter | undefined {
  return db.select().from(savedFilters).where(eq(savedFilters.id, id)).get()
}

/**
 * List all saved filters ordered by position.
 */
export function listSavedFilters(db: DrizzleDb): SavedFilter[] {
  return db.select().from(savedFilters).orderBy(asc(savedFilters.position)).all()
}

/**
 * Get the next position for a new saved filter.
 */
export function getNextSavedFilterPosition(db: DrizzleDb): number {
  const filters = db.select().from(savedFilters).all()
  if (filters.length === 0) return 0
  const maxPosition = Math.max(...filters.map((f) => f.position))
  return maxPosition + 1
}

/**
 * Reorder saved filters by updating positions.
 */
export function reorderSavedFilters(
  db: DrizzleDb,
  ids: string[],
  positions: number[]
): void {
  if (ids.length !== positions.length) {
    throw new Error('ids and positions arrays must have the same length')
  }

  // Update each filter's position
  for (let i = 0; i < ids.length; i++) {
    db.update(savedFilters)
      .set({ position: positions[i] })
      .where(eq(savedFilters.id, ids[i]))
      .run()
  }
}

/**
 * Check if a saved filter exists.
 */
export function savedFilterExists(db: DrizzleDb, id: string): boolean {
  const result = db.select({ id: savedFilters.id }).from(savedFilters).where(eq(savedFilters.id, id)).get()
  return result !== undefined
}
