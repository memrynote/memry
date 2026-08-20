/**
 * data.db reads/writes for the custom icon library.
 *
 * @module icons/store
 */

import { asc, eq } from 'drizzle-orm'
import { customIcons, type CustomIconRow } from '@memry/db-schema/schema/custom-icons'
import { utcNow } from '@memry/shared/utc'
import type { DataDb } from '../database/types'

export function listCustomIcons(db: DataDb): CustomIconRow[] {
  return db.select().from(customIcons).orderBy(asc(customIcons.createdAt)).all()
}

export function getCustomIcon(db: DataDb, id: string): CustomIconRow | undefined {
  return db.select().from(customIcons).where(eq(customIcons.id, id)).get()
}

export function insertCustomIcon(
  db: DataDb,
  input: { id: string; name: string; ext: string; data: string }
): CustomIconRow {
  const now = utcNow()
  return db
    .insert(customIcons)
    .values({ ...input, createdAt: now, updatedAt: now })
    .returning()
    .get()
}

export function renameCustomIcon(db: DataDb, id: string, name: string): CustomIconRow | undefined {
  return db
    .update(customIcons)
    .set({ name, updatedAt: utcNow() })
    .where(eq(customIcons.id, id))
    .returning()
    .get()
}

/** Hard delete, matching the other record-sync tables that tombstone server-side. */
export function deleteCustomIcon(db: DataDb, id: string): boolean {
  return db.delete(customIcons).where(eq(customIcons.id, id)).run().changes > 0
}
