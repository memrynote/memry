/**
 * Sync Database Schema
 *
 * Local tables for sync state, device tracking, and sync queue.
 * These tables are part of data.db (source of truth).
 *
 * @module shared/db/schema/sync
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// =============================================================================
// Device Platform Constants
// =============================================================================

export const devicePlatform = {
  MACOS: 'macos',
  WINDOWS: 'windows',
  LINUX: 'linux',
  IOS: 'ios',
  ANDROID: 'android'
} as const

export type DevicePlatform = (typeof devicePlatform)[keyof typeof devicePlatform]

// =============================================================================
// Sync Status Constants
// =============================================================================

export const syncStatus = {
  INITIALIZING: 'initializing',
  IDLE: 'idle',
  SYNCING: 'syncing',
  OFFLINE: 'offline',
  ERROR: 'error'
} as const

export type SyncStatus = (typeof syncStatus)[keyof typeof syncStatus]

// =============================================================================
// Sync Queue Item Status Constants
// =============================================================================

export const syncQueueStatus = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  FAILED: 'failed'
} as const

export type SyncQueueStatus = (typeof syncQueueStatus)[keyof typeof syncQueueStatus]

// =============================================================================
// Sync Item Type Constants
// =============================================================================

export const syncItemType = {
  NOTE: 'note',
  TASK: 'task',
  PROJECT: 'project',
  SETTINGS: 'settings',
  ATTACHMENT: 'attachment',
  INBOX_ITEM: 'inbox_item',
  SAVED_FILTER: 'saved_filter'
} as const

export type SyncItemType = (typeof syncItemType)[keyof typeof syncItemType]

// =============================================================================
// Sync Operation Constants
// =============================================================================

export const syncOperation = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete'
} as const

export type SyncOperation = (typeof syncOperation)[keyof typeof syncOperation]

// =============================================================================
// Local Devices Table
// =============================================================================
/**
 * Tracks known devices linked to this account.
 * The current device is marked with isCurrentDevice = true.
 */

export const localDevices = sqliteTable(
  'local_devices',
  {
    /** Device UUID */
    id: text('id').primaryKey(),

    /** User-friendly device name */
    name: text('name').notNull(),

    /** Device platform */
    platform: text('platform').notNull(),

    /** Operating system version */
    osVersion: text('os_version'),

    /** Application version */
    appVersion: text('app_version').notNull(),

    /** When this device was linked */
    linkedAt: text('linked_at')
      .notNull()
      .default(sql`(datetime('now'))`),

    /** Last successful sync timestamp */
    lastSyncAt: text('last_sync_at'),

    /** Whether this is the current device */
    isCurrentDevice: integer('is_current_device', { mode: 'boolean' }).default(false),

    /** When the device was revoked (soft delete) */
    revokedAt: text('revoked_at')
  },
  (table) => [
    index('idx_local_devices_current').on(table.isCurrentDevice),
    index('idx_local_devices_revoked').on(table.revokedAt)
  ]
)

export type LocalDevice = typeof localDevices.$inferSelect
export type NewLocalDevice = typeof localDevices.$inferInsert

// =============================================================================
// Sync Queue Table
// =============================================================================
/**
 * Queue of pending sync operations.
 * Items are added when local changes occur and removed after successful sync.
 */

export const syncQueue = sqliteTable(
  'sync_queue',
  {
    /** Queue item UUID */
    id: text('id').primaryKey(),

    /** Type of item being synced */
    type: text('type').notNull(),

    /** ID of the item being synced */
    itemId: text('item_id').notNull(),

    /** Operation type */
    operation: text('operation').notNull(),

    /** Encrypted payload (Base64 JSON) */
    payload: text('payload').notNull(),

    /** Priority (higher = more urgent) */
    priority: integer('priority').default(0),

    /** Number of sync attempts */
    attempts: integer('attempts').default(0),

    /** Last attempt timestamp */
    lastAttempt: text('last_attempt'),

    /** Error message from last failed attempt */
    errorMessage: text('error_message'),

    /** Queue item status */
    status: text('status').notNull().default('pending'),

    /** When the item was queued */
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index('idx_sync_queue_type').on(table.type),
    index('idx_sync_queue_status').on(table.status),
    index('idx_sync_queue_created').on(table.createdAt),
    index('idx_sync_queue_priority').on(table.priority)
  ]
)

export type SyncQueueItem = typeof syncQueue.$inferSelect
export type NewSyncQueueItem = typeof syncQueue.$inferInsert

// =============================================================================
// Sync State Table
// =============================================================================
/**
 * Key-value store for sync state.
 * Stores last sync timestamp, device clock, server clock, etc.
 */

export const syncState = sqliteTable('sync_state', {
  /** State key (e.g., 'last_sync_at', 'device_clock') */
  key: text('key').primaryKey(),

  /** State value (JSON or string) */
  value: text('value').notNull(),

  /** Last update timestamp */
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`)
})

export type SyncStateEntry = typeof syncState.$inferSelect
export type NewSyncStateEntry = typeof syncState.$inferInsert

// =============================================================================
// Sync State Keys
// =============================================================================

export const SYNC_STATE_KEYS = {
  /** Unix timestamp of last successful sync */
  LAST_SYNC_AT: 'last_sync_at',

  /** Current sync status */
  SYNC_STATUS: 'sync_status',

  /** Number of items in sync queue */
  PENDING_COUNT: 'pending_count',

  /** Last sync error message */
  LAST_ERROR: 'last_error',

  /** Last known server timestamp */
  SERVER_CLOCK: 'server_clock',

  /** This device's vector clock (JSON) */
  DEVICE_CLOCK: 'device_clock',

  /** User ID */
  USER_ID: 'user_id',

  /** Device ID */
  DEVICE_ID: 'device_id',

  /** Whether initial sync has completed */
  INITIAL_SYNC_COMPLETE: 'initial_sync_complete'
} as const

export type SyncStateKey = (typeof SYNC_STATE_KEYS)[keyof typeof SYNC_STATE_KEYS]

// =============================================================================
// Sync History Table
// =============================================================================
/**
 * Audit log of sync operations for debugging and user visibility.
 * Older entries are periodically cleaned up.
 */

export const syncHistory = sqliteTable(
  'sync_history',
  {
    /** History entry UUID */
    id: text('id').primaryKey(),

    /** Operation type */
    type: text('type').notNull(),

    /** Number of items synced */
    itemCount: integer('item_count').notNull(),

    /** Direction of sync */
    direction: text('direction'),

    /** Additional details (JSON) */
    details: text('details', { mode: 'json' }),

    /** Duration of operation in milliseconds */
    durationMs: integer('duration_ms'),

    /** When the operation occurred */
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index('idx_sync_history_created').on(table.createdAt),
    index('idx_sync_history_type').on(table.type)
  ]
)

export type SyncHistoryEntry = typeof syncHistory.$inferSelect
export type NewSyncHistoryEntry = typeof syncHistory.$inferInsert

// =============================================================================
// Sync History Types
// =============================================================================

export const syncHistoryType = {
  PUSH: 'push',
  PULL: 'pull',
  ERROR: 'error'
} as const

export type SyncHistoryType = (typeof syncHistoryType)[keyof typeof syncHistoryType]

export const syncDirection = {
  UPLOAD: 'upload',
  DOWNLOAD: 'download'
} as const

export type SyncDirection = (typeof syncDirection)[keyof typeof syncDirection]

// =============================================================================
// Sync History Details Type
// =============================================================================

export interface SyncHistoryDetails {
  notes?: number
  tasks?: number
  projects?: number
  attachments?: number
  error?: string
  failedItems?: string[]
}
