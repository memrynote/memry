import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { VectorClock } from '@memry/contracts/sync-api'

/**
 * Read-only locks (`vault_lock` sync records). One row per locked or once-locked
 * target; unlocking flips `locked` to false and keeps the row, so the record id
 * (`note:<id>` / `folder:<path>`) never has to come back after a delete.
 */
export const vaultLocks = sqliteTable('vault_locks', {
  id: text('id').primaryKey(),
  /** `note` or `folder`. Free text so a row from a newer build is kept, not rejected. */
  targetKind: text('target_kind').notNull(),
  /** The note id, or the folder's vault-relative path. */
  target: text('target').notNull(),
  locked: integer('locked', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  /** Whole-row LWW clock. NULL = never synced; `seedUnclocked` keys on it. */
  clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
  syncedAt: text('synced_at')
})

/**
 * The bytes of each locked markdown note as this app last wrote or accepted
 * them. Device-local, never synced. When a locked file changes outside the app,
 * these bytes are what is written back.
 */
export const vaultLockBaselines = sqliteTable('vault_lock_baselines', {
  noteId: text('note_id').primaryKey(),
  contentHash: text('content_hash').notNull(),
  content: text('content').notNull(),
  updatedAt: text('updated_at').notNull()
})

/**
 * The permission bits each file had before a lock made it read-only, keyed by
 * vault-relative path. Device-local, never synced. Unlocking gives the file
 * these bits back; a row also marks a file the lock still has to release.
 */
export const vaultLockFileModes = sqliteTable('vault_lock_file_modes', {
  path: text('path').primaryKey(),
  mode: integer('mode').notNull()
})

export type VaultLockRow = typeof vaultLocks.$inferSelect
export type VaultLockBaselineRow = typeof vaultLockBaselines.$inferSelect
