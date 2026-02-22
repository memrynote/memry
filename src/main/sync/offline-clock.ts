import { eq } from 'drizzle-orm'
import { tasks } from '@shared/db/schema/tasks'
import { projects } from '@shared/db/schema/projects'
import { inboxItems } from '@shared/db/schema/inbox'
import { savedFilters } from '@shared/db/schema/settings'
import type { VectorClock, FieldClocks } from '@shared/contracts/sync-api'
import { increment } from './vector-clock'
import { initAllFieldClocks, TASK_SYNCABLE_FIELDS, PROJECT_SYNCABLE_FIELDS } from './field-merge'
import { createLogger } from '../lib/logger'
import type { DrizzleDb } from '../database/client'

const OFFLINE_DEVICE_KEY = '_offline'
const log = createLogger('OfflineClock')

function incrementFieldClocksForFields(
  existing: FieldClocks | null,
  existingDocClock: VectorClock,
  changedFields: string[],
  allSyncableFields: readonly string[]
): FieldClocks {
  const fc = existing ?? initAllFieldClocks(existingDocClock, allSyncableFields)
  const updated = { ...fc }
  for (const field of changedFields) {
    if ((allSyncableFields as readonly string[]).includes(field)) {
      updated[field] = increment(updated[field] ?? {}, OFFLINE_DEVICE_KEY)
    }
  }
  return updated
}

export function incrementTaskClocksOffline(
  db: DrizzleDb,
  taskId: string,
  changedFields: string[]
): void {
  try {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) return

    const existingClock = (task.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)
    const updatedFC = incrementFieldClocksForFields(
      task.fieldClocks as FieldClocks | null,
      existingClock,
      changedFields,
      TASK_SYNCABLE_FIELDS
    )

    db.update(tasks)
      .set({ clock: newClock, fieldClocks: updatedFC })
      .where(eq(tasks.id, taskId))
      .run()

    log.info('=== OFFLINE CLOCK: task incremented ===', {
      taskId,
      changedFields,
      newClock,
      updatedFieldClocks: Object.fromEntries(
        changedFields.map((f) => [f, updatedFC[f]])
      )
    })
  } catch (err) {
    log.warn('Failed to increment offline task clocks', { taskId, error: err })
  }
}

export function incrementProjectClocksOffline(
  db: DrizzleDb,
  projectId: string,
  changedFields?: string[]
): void {
  try {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) return

    const existingClock = (project.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)
    const fields = changedFields ?? [...PROJECT_SYNCABLE_FIELDS]
    const updatedFC = incrementFieldClocksForFields(
      project.fieldClocks as FieldClocks | null,
      existingClock,
      fields,
      PROJECT_SYNCABLE_FIELDS
    )

    db.update(projects)
      .set({ clock: newClock, fieldClocks: updatedFC })
      .where(eq(projects.id, projectId))
      .run()

    log.debug('Incremented offline project clocks', { projectId, fields })
  } catch (err) {
    log.warn('Failed to increment offline project clocks', { projectId, error: err })
  }
}

export function incrementInboxClockOffline(db: DrizzleDb, itemId: string): void {
  try {
    const item = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
    if (!item) return

    const existingClock = (item.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)

    db.update(inboxItems)
      .set({ clock: newClock })
      .where(eq(inboxItems.id, itemId))
      .run()

    log.debug('Incremented offline inbox clock', { itemId })
  } catch (err) {
    log.warn('Failed to increment offline inbox clock', { itemId, error: err })
  }
}

export function incrementFilterClockOffline(db: DrizzleDb, filterId: string): void {
  try {
    const filter = db.select().from(savedFilters).where(eq(savedFilters.id, filterId)).get()
    if (!filter) return

    const existingClock = (filter.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)

    db.update(savedFilters)
      .set({ clock: newClock })
      .where(eq(savedFilters.id, filterId))
      .run()

    log.debug('Incremented offline filter clock', { filterId })
  } catch (err) {
    log.warn('Failed to increment offline filter clock', { filterId, error: err })
  }
}
