/**
 * data.db reads and writes for read-only locks and their baselines.
 *
 * @module vault-locks/store
 */

import { eq } from 'drizzle-orm'
import {
  vaultLockBaselines,
  vaultLockFileModes,
  vaultLocks,
  type VaultLockBaselineRow,
  type VaultLockRow
} from '@memry/db-schema/schema/vault-locks'
import { vaultLockId, type VaultLockTargetKind } from '@memry/contracts/vault-locks-api'
import { utcNow } from '@memry/shared/utc'
import type { DataDb } from '../database/types'

export function listLockedRows(db: DataDb): VaultLockRow[] {
  return db.select().from(vaultLocks).where(eq(vaultLocks.locked, true)).all()
}

export function getLockRow(db: DataDb, id: string): VaultLockRow | undefined {
  return db.select().from(vaultLocks).where(eq(vaultLocks.id, id)).get()
}

/**
 * Lock or unlock a target. Returns the row and whether it was new, so the
 * caller enqueues a sync create or update. Unlocking a target that was never
 * locked writes nothing and returns null.
 */
export function writeLockRow(
  db: DataDb,
  kind: VaultLockTargetKind,
  target: string,
  locked: boolean
): { row: VaultLockRow; created: boolean } | null {
  const id = vaultLockId(kind, target)
  const existing = getLockRow(db, id)
  const now = utcNow()
  if (existing) {
    if (existing.locked === locked) return { row: existing, created: false }
    const row = db
      .update(vaultLocks)
      .set({ locked, updatedAt: now })
      .where(eq(vaultLocks.id, id))
      .returning()
      .get()
    return { row, created: false }
  }
  if (!locked) return null
  const row = db
    .insert(vaultLocks)
    .values({ id, targetKind: kind, target, locked, createdAt: now, updatedAt: now })
    .returning()
    .get()
  return { row, created: true }
}

export function getBaseline(db: DataDb, noteId: string): VaultLockBaselineRow | undefined {
  return db.select().from(vaultLockBaselines).where(eq(vaultLockBaselines.noteId, noteId)).get()
}

export function writeBaseline(
  db: DataDb,
  noteId: string,
  content: string,
  contentHash: string
): void {
  const updatedAt = utcNow()
  db.insert(vaultLockBaselines)
    .values({ noteId, content, contentHash, updatedAt })
    .onConflictDoUpdate({
      target: vaultLockBaselines.noteId,
      set: { content, contentHash, updatedAt }
    })
    .run()
}

export function deleteBaseline(db: DataDb, noteId: string): void {
  db.delete(vaultLockBaselines).where(eq(vaultLockBaselines.noteId, noteId)).run()
}

export function listBaselineNoteIds(db: DataDb): string[] {
  return db
    .select({ noteId: vaultLockBaselines.noteId })
    .from(vaultLockBaselines)
    .all()
    .map((row) => row.noteId)
}

export function getFileMode(db: DataDb, path: string): number | undefined {
  return db
    .select({ mode: vaultLockFileModes.mode })
    .from(vaultLockFileModes)
    .where(eq(vaultLockFileModes.path, path))
    .get()?.mode
}

/** Keeps the first mode recorded for a path: later locks see the bits the lock itself set. */
export function recordFileMode(db: DataDb, path: string, mode: number): void {
  db.insert(vaultLockFileModes).values({ path, mode }).onConflictDoNothing().run()
}

export function forgetFileMode(db: DataDb, path: string): void {
  db.delete(vaultLockFileModes).where(eq(vaultLockFileModes.path, path)).run()
}

export function listFileModePaths(db: DataDb): string[] {
  return db
    .select({ path: vaultLockFileModes.path })
    .from(vaultLockFileModes)
    .all()
    .map((row) => row.path)
}
