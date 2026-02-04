/**
 * Schema for sync-related tables in data.db
 *
 * T018: Local sync tables for client-side sync state management.
 * These tables track sync queue, state, history, and linked devices.
 *
 * @module db/schema/sync-schema
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

/**
 * Local devices table
 * Stores information about linked devices for the current user
 */
export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  platform: text('platform').notNull(),
  osVersion: text('os_version'),
  appVersion: text('app_version').notNull(),
  authPublicKey: text('auth_public_key'),
  linkedAt: text('linked_at').notNull(),
  lastSyncAt: text('last_sync_at'),
  isCurrentDevice: integer('is_current_device', { mode: 'boolean' }).default(false)
})

/**
 * Sync queue table
 * Stores pending sync operations to be sent to the server
 */
export const syncQueue = sqliteTable(
  'sync_queue',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(), // 'task' | 'project' | 'note' | etc.
    itemId: text('item_id').notNull(),
    operation: text('operation').notNull(), // 'create' | 'update' | 'delete'
    payload: text('payload').notNull(), // JSON stringified data
    priority: integer('priority').default(0),
    attempts: integer('attempts').default(0),
    lastAttempt: text('last_attempt'),
    errorMessage: text('error_message'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index('idx_sync_queue_type').on(table.type),
    index('idx_sync_queue_created').on(table.createdAt)
  ]
)

/**
 * Sync state table
 * Key-value store for sync-related state (cursors, tokens, etc.)
 */
export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`)
})

/**
 * Sync history table
 * Logs sync operations for debugging and user visibility
 */
export const syncHistory = sqliteTable(
  'sync_history',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(), // 'push' | 'pull' | 'conflict' | 'error'
    itemCount: integer('item_count').notNull(),
    direction: text('direction'), // 'up' | 'down' | null
    details: text('details', { mode: 'json' }),
    durationMs: integer('duration_ms'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [index('idx_sync_history_created').on(table.createdAt)]
)

/**
 * CRDT sequence state table
 * Tracks last known sequence number per note for sync continuation after restart
 */
export const crdtSequenceState = sqliteTable('crdt_sequence_state', {
  noteId: text('note_id').primaryKey(),
  lastKnownSequence: integer('last_known_sequence').notNull().default(0),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`)
})

// Type exports
export type CrdtSequenceState = typeof crdtSequenceState.$inferSelect
export type NewCrdtSequenceState = typeof crdtSequenceState.$inferInsert
export type Device = typeof devices.$inferSelect
export type NewDevice = typeof devices.$inferInsert
export type SyncQueueItem = typeof syncQueue.$inferSelect
export type NewSyncQueueItem = typeof syncQueue.$inferInsert
export type SyncState = typeof syncState.$inferSelect
export type NewSyncState = typeof syncState.$inferInsert
export type SyncHistoryEntry = typeof syncHistory.$inferSelect
export type NewSyncHistoryEntry = typeof syncHistory.$inferInsert
