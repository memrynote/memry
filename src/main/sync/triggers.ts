/**
 * Sync Triggers
 *
 * Helper functions to queue items for sync when data is modified.
 * These should be called after successful CRUD operations to ensure
 * changes are synced across devices.
 *
 * @module main/sync/triggers
 */

import { getSyncQueue } from './queue'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { SyncItemType, SyncOperation } from '@shared/db/schema/sync'
import { hasMasterKey, getDeviceId } from '../crypto/keychain'

// =============================================================================
// Types
// =============================================================================

export interface SyncTriggerOptions {
  /** Priority of the sync item (higher = synced first) */
  priority?: number
  /** Vector clock for conflict detection */
  clock?: VectorClock
  /** Optional payload to sync (if empty, engine will fetch from DB) */
  payload?: string
}

// =============================================================================
// Check Functions
// =============================================================================

/**
 * Check if sync is enabled (user has master key and device is registered).
 * If sync is not enabled, triggers are no-ops.
 */
export async function isSyncEnabled(): Promise<boolean> {
  try {
    const [hasKey, deviceId] = await Promise.all([hasMasterKey(), getDeviceId()])
    return hasKey && !!deviceId
  } catch {
    return false
  }
}

// =============================================================================
// Queue Trigger Functions
// =============================================================================

/**
 * Queue a task for sync.
 *
 * @param taskId - ID of the task
 * @param operation - Operation type (create, update, delete)
 * @param options - Additional options
 */
export async function queueTaskSync(
  taskId: string,
  operation: SyncOperation,
  options: SyncTriggerOptions = {}
): Promise<void> {
  if (!(await isSyncEnabled())) return

  const queue = getSyncQueue()
  await queue.addItem({
    type: 'task' as SyncItemType,
    itemId: taskId,
    operation,
    payload: options.payload ?? '',
    priority: options.priority ?? 50
  })
}

/**
 * Queue a project for sync.
 *
 * @param projectId - ID of the project
 * @param operation - Operation type (create, update, delete)
 * @param options - Additional options
 */
export async function queueProjectSync(
  projectId: string,
  operation: SyncOperation,
  options: SyncTriggerOptions = {}
): Promise<void> {
  if (!(await isSyncEnabled())) return

  const queue = getSyncQueue()
  await queue.addItem({
    type: 'project' as SyncItemType,
    itemId: projectId,
    operation,
    payload: options.payload ?? '',
    priority: options.priority ?? 40
  })
}

/**
 * Queue an inbox item for sync.
 *
 * @param itemId - ID of the inbox item
 * @param operation - Operation type (create, update, delete)
 * @param options - Additional options
 */
export async function queueInboxItemSync(
  itemId: string,
  operation: SyncOperation,
  options: SyncTriggerOptions = {}
): Promise<void> {
  if (!(await isSyncEnabled())) return

  const queue = getSyncQueue()
  await queue.addItem({
    type: 'inbox_item' as SyncItemType,
    itemId,
    operation,
    payload: options.payload ?? '',
    priority: options.priority ?? 50
  })
}

/**
 * Queue a saved filter for sync.
 *
 * @param filterId - ID of the saved filter
 * @param operation - Operation type (create, update, delete)
 * @param options - Additional options
 */
export async function queueSavedFilterSync(
  filterId: string,
  operation: SyncOperation,
  options: SyncTriggerOptions = {}
): Promise<void> {
  if (!(await isSyncEnabled())) return

  const queue = getSyncQueue()
  await queue.addItem({
    type: 'saved_filter' as SyncItemType,
    itemId: filterId,
    operation,
    payload: options.payload ?? '',
    priority: options.priority ?? 30
  })
}

/**
 * Queue a settings change for sync.
 *
 * @param settingKey - Key of the setting
 * @param operation - Operation type (create, update, delete)
 * @param options - Additional options
 */
export async function queueSettingsSync(
  settingKey: string,
  operation: SyncOperation,
  options: SyncTriggerOptions = {}
): Promise<void> {
  if (!(await isSyncEnabled())) return

  const queue = getSyncQueue()
  await queue.addItem({
    type: 'settings' as SyncItemType,
    itemId: settingKey,
    operation,
    payload: options.payload ?? '',
    priority: options.priority ?? 20
  })
}

/**
 * Queue a note for sync.
 *
 * @param noteId - ID of the note
 * @param operation - Operation type (create, update, delete)
 * @param options - Additional options
 */
export async function queueNoteSync(
  noteId: string,
  operation: SyncOperation,
  options: SyncTriggerOptions = {}
): Promise<void> {
  if (!(await isSyncEnabled())) return

  const queue = getSyncQueue()
  await queue.addItem({
    type: 'note' as SyncItemType,
    itemId: noteId,
    operation,
    payload: options.payload ?? '',
    priority: options.priority ?? 50
  })
}

/**
 * Queue an attachment for sync.
 *
 * @param attachmentId - ID of the attachment
 * @param operation - Operation type (create, update, delete)
 * @param options - Additional options
 */
export async function queueAttachmentSync(
  attachmentId: string,
  operation: SyncOperation,
  options: SyncTriggerOptions = {}
): Promise<void> {
  if (!(await isSyncEnabled())) return

  const queue = getSyncQueue()
  await queue.addItem({
    type: 'attachment' as SyncItemType,
    itemId: attachmentId,
    operation,
    payload: options.payload ?? '',
    priority: options.priority ?? 60
  })
}

// =============================================================================
// Batch Operations
// =============================================================================

/**
 * Queue multiple items for sync.
 *
 * @param items - Array of items to queue
 */
export async function queueBulkSync(
  items: Array<{
    type: SyncItemType
    itemId: string
    operation: SyncOperation
    payload?: string
    priority?: number
  }>
): Promise<void> {
  if (!(await isSyncEnabled())) return

  const queue = getSyncQueue()
  for (const item of items) {
    await queue.addItem({
      type: item.type,
      itemId: item.itemId,
      operation: item.operation,
      payload: item.payload ?? '',
      priority: item.priority ?? 50
    })
  }
}
