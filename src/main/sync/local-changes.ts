/**
 * Local Change Backlog
 *
 * Queues locally modified items that were created while sync was unavailable.
 *
 * @module sync/local-changes
 */

import { eq } from 'drizzle-orm'
import { getDatabase } from '../database'
import { tasks } from '@shared/db/schema/tasks'
import { inboxItems } from '@shared/db/schema/inbox'
import { savedFilters } from '@shared/db/schema/settings'
import { getSyncQueue } from './queue'
import { getSyncEngine } from './engine'
import { retrieveDeviceKeyPair } from '../crypto/keychain'
import { emptyClock, incrementClock, type VectorClock } from './vector-clock'
import type { SyncOperation } from '@shared/contracts/sync-api'

const LOG_PREFIX = '[SyncLocalChanges]'

function parseClock(value: unknown): VectorClock | null {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as VectorClock
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }
  if (typeof value === 'object') {
    return value as VectorClock
  }
  return null
}

function hasClock(clock: VectorClock | null): boolean {
  return !!clock && Object.keys(clock).length > 0
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null

  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const ms = Date.parse(normalized)
  return Number.isNaN(ms) ? null : ms
}

function wasModifiedAfter(
  lastSyncAt: number | undefined,
  modifiedAt: string | null | undefined,
  createdAt: string | null | undefined
): boolean {
  if (!lastSyncAt) return false

  const modifiedMs = parseTimestamp(modifiedAt) ?? parseTimestamp(createdAt)
  if (modifiedMs === null) return true
  return modifiedMs > lastSyncAt
}

export interface LocalChangeQueueResult {
  tasks: number
  inbox: number
  filters: number
}

/**
 * Queue local changes since the last successful sync.
 * Uses the device keypair to generate fresh vector clocks.
 */
export async function queueLocalChangesSinceLastSync(): Promise<LocalChangeQueueResult> {
  let db: ReturnType<typeof getDatabase>
  try {
    db = getDatabase()
  } catch {
    console.info(`${LOG_PREFIX} Skipped: no open vault`)
    return { tasks: 0, inbox: 0, filters: 0 }
  }

  const keyPair = await retrieveDeviceKeyPair().catch(() => null)
  if (!keyPair?.deviceId) {
    console.info(`${LOG_PREFIX} Skipped: no device keypair`)
    return { tasks: 0, inbox: 0, filters: 0 }
  }

  const engine = getSyncEngine()
  let lastSyncAt: number | undefined
  if (engine) {
    try {
      lastSyncAt = await engine.getLastSyncAt()
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to read last sync timestamp:`, error)
    }
  }

  if (!lastSyncAt) {
    console.info(`${LOG_PREFIX} No last sync timestamp; only queuing items missing clocks`)
  }

  const queue = getSyncQueue()
  const queuedKeys = new Set(queue.getAll().map((item) => `${item.type}:${item.itemId}`))

  let tasksQueued = 0
  let inboxQueued = 0
  let filtersQueued = 0

  const taskRows = db.select().from(tasks).all()
  for (const task of taskRows) {
    if (queuedKeys.has(`task:${task.id}`)) continue

    const currentClock = parseClock(task.clock)
    const clockMissing = !hasClock(currentClock)
    if (!clockMissing && !wasModifiedAfter(lastSyncAt, task.modifiedAt, task.createdAt)) {
      continue
    }

    const nextClock = incrementClock(currentClock ?? emptyClock(), keyPair.deviceId)
    try {
      db.update(tasks)
        .set({ clock: JSON.stringify(nextClock) })
        .where(eq(tasks.id, task.id))
        .run()
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to update task clock`, { id: task.id, error })
      continue
    }

    const payload = { ...task, clock: JSON.stringify(nextClock) }
    const operation: SyncOperation = clockMissing ? 'create' : 'update'
    try {
      await queue.add('task', task.id, operation, JSON.stringify(payload), 0)
      tasksQueued += 1
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to queue task`, { id: task.id, error })
    }
  }

  const inboxRows = db.select().from(inboxItems).all()
  for (const item of inboxRows) {
    if (queuedKeys.has(`inbox:${item.id}`)) continue

    const currentClock = parseClock(item.clock)
    const clockMissing = !hasClock(currentClock)
    if (!clockMissing && !wasModifiedAfter(lastSyncAt, item.modifiedAt, item.createdAt)) {
      continue
    }

    const nextClock = incrementClock(currentClock ?? emptyClock(), keyPair.deviceId)
    try {
      db.update(inboxItems).set({ clock: nextClock }).where(eq(inboxItems.id, item.id)).run()
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to update inbox clock`, { id: item.id, error })
      continue
    }

    const payload = { ...item, clock: nextClock }
    const operation: SyncOperation = clockMissing ? 'create' : 'update'
    try {
      await queue.add('inbox', item.id, operation, JSON.stringify(payload), 0)
      inboxQueued += 1
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to queue inbox item`, { id: item.id, error })
    }
  }

  const filterRows = db.select().from(savedFilters).all()
  for (const filter of filterRows) {
    if (queuedKeys.has(`filter:${filter.id}`)) continue

    const currentClock = parseClock(filter.clock)
    const clockMissing = !hasClock(currentClock)
    if (!clockMissing && !wasModifiedAfter(lastSyncAt, filter.createdAt, filter.createdAt)) {
      continue
    }

    const nextClock = incrementClock(currentClock ?? emptyClock(), keyPair.deviceId)
    try {
      db.update(savedFilters).set({ clock: nextClock }).where(eq(savedFilters.id, filter.id)).run()
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to update filter clock`, { id: filter.id, error })
      continue
    }

    const payload = { ...filter, clock: nextClock }
    const operation: SyncOperation = clockMissing ? 'create' : 'update'
    try {
      await queue.add('filter', filter.id, operation, JSON.stringify(payload), 0)
      filtersQueued += 1
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to queue saved filter`, { id: filter.id, error })
    }
  }

  if (tasksQueued + inboxQueued + filtersQueued > 0) {
    console.info(`${LOG_PREFIX} Queued local changes`, {
      tasks: tasksQueued,
      inbox: inboxQueued,
      filters: filtersQueued
    })
  }

  return { tasks: tasksQueued, inbox: inboxQueued, filters: filtersQueued }
}
