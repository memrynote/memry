/**
 * Sync Bootstrap
 *
 * Handles initial sync of existing data when sync is first enabled.
 * This ensures all data created before sync was enabled gets uploaded.
 *
 * @module main/sync/bootstrap
 */

import { eq } from 'drizzle-orm'
import { getDatabase } from '../database/client'
import { syncState, SYNC_STATE_KEYS } from '@shared/db/schema/sync'
import { projects } from '@shared/db/schema/projects'
import { tasks } from '@shared/db/schema/tasks'
import { inboxItems } from '@shared/db/schema/inbox'
import { savedFilters, settings } from '@shared/db/schema/settings'
import { queueBulkSync, isSyncEnabled } from './triggers'
import type { SyncItemType, SyncOperation } from '@shared/db/schema/sync'

// =============================================================================
// Types
// =============================================================================

/** Result of bootstrap operation */
export interface BootstrapResult {
  success: boolean
  skipped: boolean
  reason?: string
  counts: {
    projects: number
    tasks: number
    inboxItems: number
    savedFilters: number
    settings: number
    total: number
  }
}

// =============================================================================
// Constants
// =============================================================================

/** Batch size for queueing items */
const BATCH_SIZE = 100

/** Priority levels for bootstrap items */
const BOOTSTRAP_PRIORITY = {
  PROJECTS: 100,
  TASKS: 75,
  INBOX_ITEMS: 50,
  SAVED_FILTERS: 30,
  SETTINGS: 20
} as const

// =============================================================================
// Bootstrap State Functions
// =============================================================================

/**
 * Check if this device has already completed initial sync bootstrap.
 *
 * @returns True if bootstrap has been completed
 */
export async function hasBootstrapped(): Promise<boolean> {
  try {
    const db = getDatabase()
    const result = await db.query.syncState.findFirst({
      where: eq(syncState.key, SYNC_STATE_KEYS.INITIAL_SYNC_COMPLETE)
    })
    return result?.value === 'true'
  } catch (error) {
    console.error('[Bootstrap] Error checking bootstrap state:', error)
    return false
  }
}

/**
 * Mark bootstrap as complete.
 */
export async function markBootstrapped(): Promise<void> {
  const db = getDatabase()
  await db
    .insert(syncState)
    .values({
      key: SYNC_STATE_KEYS.INITIAL_SYNC_COMPLETE,
      value: 'true',
      updatedAt: new Date().toISOString()
    })
    .onConflictDoUpdate({
      target: syncState.key,
      set: {
        value: 'true',
        updatedAt: new Date().toISOString()
      }
    })
  console.log('[Bootstrap] Marked as complete')
}

/**
 * Clear the bootstrap flag.
 *
 * This should be called when:
 * - User re-authenticates after keychain was cleared
 * - Device needs to re-bootstrap existing data
 */
export async function clearBootstrapFlag(): Promise<void> {
  try {
    const db = getDatabase()
    await db.delete(syncState).where(eq(syncState.key, SYNC_STATE_KEYS.INITIAL_SYNC_COMPLETE))
    console.log('[Bootstrap] Cleared bootstrap flag')
  } catch (error) {
    console.error('[Bootstrap] Error clearing bootstrap flag:', error)
  }
}

// =============================================================================
// Bootstrap Execution
// =============================================================================

/**
 * Queue all existing data for sync.
 *
 * This should be called after sync is first enabled (device linking).
 * It queues all existing projects, tasks, inbox items, saved filters,
 * and settings for upload to the sync server.
 *
 * The function is idempotent - it will skip if already bootstrapped,
 * unless the session is incomplete (e.g., keychain was cleared).
 *
 * @returns Bootstrap result with counts of queued items
 */
export async function performBootstrap(): Promise<BootstrapResult> {
  console.log('[Bootstrap] Starting initial sync bootstrap...')

  // Check if already bootstrapped
  // Note: Callers (sign-in handlers) explicitly clear this flag for fresh sign-ins
  if (await hasBootstrapped()) {
    console.log('[Bootstrap] Already completed, skipping')
    return {
      success: true,
      skipped: true,
      reason: 'Already bootstrapped',
      counts: { projects: 0, tasks: 0, inboxItems: 0, savedFilters: 0, settings: 0, total: 0 }
    }
  }

  // Check if sync is enabled
  if (!(await isSyncEnabled())) {
    console.log('[Bootstrap] Sync not enabled, skipping')
    return {
      success: true,
      skipped: true,
      reason: 'Sync not enabled',
      counts: { projects: 0, tasks: 0, inboxItems: 0, savedFilters: 0, settings: 0, total: 0 }
    }
  }

  const db = getDatabase()
  const counts = {
    projects: 0,
    tasks: 0,
    inboxItems: 0,
    savedFilters: 0,
    settings: 0,
    total: 0
  }

  try {
    // 1. Queue all projects (priority 100)
    console.log('[Bootstrap] Queuing projects...')
    const allProjects = await db.select({ id: projects.id }).from(projects)
    counts.projects = allProjects.length

    for (let i = 0; i < allProjects.length; i += BATCH_SIZE) {
      const batch = allProjects.slice(i, i + BATCH_SIZE)
      await queueBulkSync(
        batch.map((p) => ({
          type: 'project' as SyncItemType,
          itemId: p.id,
          operation: 'create' as SyncOperation,
          priority: BOOTSTRAP_PRIORITY.PROJECTS
        }))
      )
    }
    console.log(`[Bootstrap] Queued ${counts.projects} projects`)

    // 2. Queue all tasks (priority 75)
    console.log('[Bootstrap] Queuing tasks...')
    const allTasks = await db.select({ id: tasks.id }).from(tasks)
    counts.tasks = allTasks.length

    for (let i = 0; i < allTasks.length; i += BATCH_SIZE) {
      const batch = allTasks.slice(i, i + BATCH_SIZE)
      await queueBulkSync(
        batch.map((t) => ({
          type: 'task' as SyncItemType,
          itemId: t.id,
          operation: 'create' as SyncOperation,
          priority: BOOTSTRAP_PRIORITY.TASKS
        }))
      )
    }
    console.log(`[Bootstrap] Queued ${counts.tasks} tasks`)

    // 3. Queue all inbox items (priority 50)
    console.log('[Bootstrap] Queuing inbox items...')
    const allInboxItems = await db.select({ id: inboxItems.id }).from(inboxItems)
    counts.inboxItems = allInboxItems.length

    for (let i = 0; i < allInboxItems.length; i += BATCH_SIZE) {
      const batch = allInboxItems.slice(i, i + BATCH_SIZE)
      await queueBulkSync(
        batch.map((item) => ({
          type: 'inbox_item' as SyncItemType,
          itemId: item.id,
          operation: 'create' as SyncOperation,
          priority: BOOTSTRAP_PRIORITY.INBOX_ITEMS
        }))
      )
    }
    console.log(`[Bootstrap] Queued ${counts.inboxItems} inbox items`)

    // 4. Queue all saved filters (priority 30)
    console.log('[Bootstrap] Queuing saved filters...')
    const allFilters = await db.select({ id: savedFilters.id }).from(savedFilters)
    counts.savedFilters = allFilters.length

    for (let i = 0; i < allFilters.length; i += BATCH_SIZE) {
      const batch = allFilters.slice(i, i + BATCH_SIZE)
      await queueBulkSync(
        batch.map((f) => ({
          type: 'saved_filter' as SyncItemType,
          itemId: f.id,
          operation: 'create' as SyncOperation,
          priority: BOOTSTRAP_PRIORITY.SAVED_FILTERS
        }))
      )
    }
    console.log(`[Bootstrap] Queued ${counts.savedFilters} saved filters`)

    // 5. Queue all settings (priority 20)
    console.log('[Bootstrap] Queuing settings...')
    const allSettings = await db.select({ key: settings.key }).from(settings)
    counts.settings = allSettings.length

    for (let i = 0; i < allSettings.length; i += BATCH_SIZE) {
      const batch = allSettings.slice(i, i + BATCH_SIZE)
      await queueBulkSync(
        batch.map((s) => ({
          type: 'settings' as SyncItemType,
          itemId: s.key,
          operation: 'create' as SyncOperation,
          priority: BOOTSTRAP_PRIORITY.SETTINGS
        }))
      )
    }
    console.log(`[Bootstrap] Queued ${counts.settings} settings`)

    // Calculate total
    counts.total =
      counts.projects + counts.tasks + counts.inboxItems + counts.savedFilters + counts.settings

    // Mark bootstrap as complete
    await markBootstrapped()

    console.log(`[Bootstrap] Complete! Queued ${counts.total} items total`)
    return {
      success: true,
      skipped: false,
      counts
    }
  } catch (error) {
    console.error('[Bootstrap] Failed:', error)
    return {
      success: false,
      skipped: false,
      reason: error instanceof Error ? error.message : String(error),
      counts
    }
  }
}
