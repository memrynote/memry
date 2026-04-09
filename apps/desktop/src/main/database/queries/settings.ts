/**
 * Settings and Saved Filters query functions for Drizzle ORM.
 * These queries operate on data.db.
 *
 * @module db/queries/settings
 */

import { eq, asc, sql } from 'drizzle-orm'
import {
  settings,
  savedFilters,
  type SavedFilter,
  type NewSavedFilter
} from '@memry/db-schema/schema/settings'
import { utcNow } from '@memry/shared/utc'
import type { DataDb } from '../types'

// ============================================================================
// Settings CRUD
// ============================================================================

/**
 * Get a setting value by key.
 */
export function getSetting(db: DataDb, key: string): string | null {
  const result = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get()
  return result?.value ?? null
}

/**
 * Set a setting value.
 */
export function setSetting(db: DataDb, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value, modifiedAt: utcNow() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, modifiedAt: utcNow() }
    })
    .run()
}

/**
 * Delete a setting by key.
 */
export function deleteSetting(db: DataDb, key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run()
}

// ============================================================================
// Saved Filters CRUD
// ============================================================================

/**
 * Insert a new saved filter.
 */
export function insertSavedFilter(db: DataDb, filter: NewSavedFilter): SavedFilter {
  return db.insert(savedFilters).values(filter).returning().get()
}

/**
 * Update an existing saved filter.
 */
export function updateSavedFilter(
  db: DataDb,
  id: string,
  updates: Partial<Omit<SavedFilter, 'id' | 'createdAt'>>
): SavedFilter | undefined {
  return db.update(savedFilters).set(updates).where(eq(savedFilters.id, id)).returning().get()
}

/**
 * Delete a saved filter by ID.
 */
export function deleteSavedFilter(db: DataDb, id: string): void {
  db.delete(savedFilters).where(eq(savedFilters.id, id)).run()
}

/**
 * Get a saved filter by ID.
 */
export function getSavedFilterById(db: DataDb, id: string): SavedFilter | undefined {
  return db.select().from(savedFilters).where(eq(savedFilters.id, id)).get()
}

/**
 * List all saved filters ordered by position.
 */
export function listSavedFilters(db: DataDb): SavedFilter[] {
  return db.select().from(savedFilters).orderBy(asc(savedFilters.position)).all()
}

/**
 * Get the next position for a new saved filter.
 */
export function getNextSavedFilterPosition(db: DataDb): number {
  const result = db
    .select({ maxPosition: sql<number>`max(${savedFilters.position})` })
    .from(savedFilters)
    .get()
  return (result?.maxPosition ?? -1) + 1
}

/**
 * Reorder saved filters by updating positions.
 */
export function reorderSavedFilters(db: DataDb, ids: string[], positions: number[]): void {
  if (ids.length !== positions.length) {
    throw new Error('ids and positions arrays must have the same length')
  }

  db.transaction((tx) => {
    for (let i = 0; i < ids.length; i++) {
      tx.update(savedFilters)
        .set({ position: positions[i] })
        .where(eq(savedFilters.id, ids[i]))
        .run()
    }
  })
}

/**
 * Check if a saved filter exists.
 */
export function savedFilterExists(db: DataDb, id: string): boolean {
  const result = db
    .select({ id: savedFilters.id })
    .from(savedFilters)
    .where(eq(savedFilters.id, id))
    .get()
  return result !== undefined
}
