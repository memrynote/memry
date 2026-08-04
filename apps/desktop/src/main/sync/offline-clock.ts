import { eq } from 'drizzle-orm'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { savedFilters } from '@memry/db-schema/schema/settings'
import { canvases } from '@memry/db-schema/schema/canvas'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { reminders } from '@memry/db-schema/schema/reminders'
import { templates } from '@memry/db-schema/schema/templates'
import {
  OFFLINE_CLOCK_DEVICE_ID,
  type VectorClock,
  type FieldClocks
} from '@memry/contracts/sync-api'
import { increment } from './vector-clock'
import { initAllFieldClocks, TASK_SYNCABLE_FIELDS, PROJECT_SYNCABLE_FIELDS } from './field-merge'
import { createLogger } from '../lib/logger'
import type { DataDb } from '../database/client'

export const OFFLINE_DEVICE_KEY = OFFLINE_CLOCK_DEVICE_ID
const log = createLogger('OfflineClock')

function hasOfflineTick(clock: VectorClock | null | undefined): boolean {
  if (!clock) return false
  return (clock[OFFLINE_DEVICE_KEY] ?? 0) > 0
}

function rebindClockDevice(clock: VectorClock, targetDeviceId: string): VectorClock {
  const offlineTick = clock[OFFLINE_DEVICE_KEY] ?? 0
  if (offlineTick <= 0) return { ...clock }

  const next = { ...clock }
  delete next[OFFLINE_DEVICE_KEY]
  next[targetDeviceId] = (next[targetDeviceId] ?? 0) + offlineTick
  return next
}

function rebindFieldClockDevice(fieldClock: VectorClock, targetDeviceId: string): VectorClock {
  const offlineTick = fieldClock[OFFLINE_DEVICE_KEY] ?? 0
  if (offlineTick <= 0) return { ...fieldClock }

  const next = { ...fieldClock }
  delete next[OFFLINE_DEVICE_KEY]
  next[targetDeviceId] = (next[targetDeviceId] ?? 0) + offlineTick
  return next
}

export function hasOfflineClockData(
  clock: VectorClock | null | undefined,
  fieldClocks: FieldClocks | null | undefined
): boolean {
  if (hasOfflineTick(clock)) return true
  if (!fieldClocks) return false
  return Object.values(fieldClocks).some((fc) => hasOfflineTick(fc))
}

export function rebindOfflineClockData(
  clock: VectorClock | null | undefined,
  fieldClocks: FieldClocks | null | undefined,
  targetDeviceId: string,
  allSyncableFields: readonly string[]
): { clock: VectorClock; fieldClocks: FieldClocks } {
  const docClock = clock ?? {}
  const nextClock = rebindClockDevice(docClock, targetDeviceId)
  const fc = fieldClocks ?? initAllFieldClocks(docClock, allSyncableFields)
  const nextFieldClocks: FieldClocks = {}

  for (const [field, fieldClock] of Object.entries(fc)) {
    nextFieldClocks[field] = rebindFieldClockDevice(fieldClock ?? {}, targetDeviceId)
  }

  return { clock: nextClock, fieldClocks: nextFieldClocks }
}

function incrementFieldClocksForFields(
  existing: FieldClocks | null,
  existingDocClock: VectorClock,
  changedFields: string[],
  allSyncableFields: readonly string[]
): FieldClocks {
  const fc = existing ?? initAllFieldClocks(existingDocClock, allSyncableFields)
  const updated = { ...fc }
  for (const field of changedFields) {
    if (allSyncableFields.includes(field)) {
      updated[field] = increment(updated[field] ?? {}, OFFLINE_DEVICE_KEY)
    }
  }
  return updated
}

export function incrementTaskClocksOffline(
  db: DataDb,
  taskId: string,
  changedFields: string[]
): void {
  try {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) return

    const existingClock = (task.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)
    const updatedFC = incrementFieldClocksForFields(
      task.fieldClocks,
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
      updatedFieldClocks: Object.fromEntries(changedFields.map((f) => [f, updatedFC[f]]))
    })
  } catch (err) {
    log.warn('Failed to increment offline task clocks', { taskId, error: err })
  }
}

export function incrementProjectClocksOffline(
  db: DataDb,
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
      project.fieldClocks,
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

export function incrementInboxClockOffline(db: DataDb, itemId: string): void {
  try {
    const item = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
    if (!item) return

    const existingClock = (item.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)

    db.update(inboxItems).set({ clock: newClock }).where(eq(inboxItems.id, itemId)).run()

    log.debug('Incremented offline inbox clock', { itemId })
  } catch (err) {
    log.warn('Failed to increment offline inbox clock', { itemId, error: err })
  }
}

export function incrementFilterClockOffline(db: DataDb, filterId: string): void {
  try {
    const filter = db.select().from(savedFilters).where(eq(savedFilters.id, filterId)).get()
    if (!filter) return

    const existingClock = (filter.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)

    db.update(savedFilters).set({ clock: newClock }).where(eq(savedFilters.id, filterId)).run()

    log.debug('Incremented offline filter clock', { filterId })
  } catch (err) {
    log.warn('Failed to increment offline filter clock', { filterId, error: err })
  }
}

export function incrementTemplateClockOffline(db: DataDb, templateId: string): void {
  try {
    const template = db.select().from(templates).where(eq(templates.id, templateId)).get()
    if (!template) return

    const existingClock = (template.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)

    db.update(templates).set({ clock: newClock }).where(eq(templates.id, templateId)).run()

    log.debug('Incremented offline template clock', { templateId })
  } catch (err) {
    log.warn('Failed to increment offline template clock', { templateId, error: err })
  }
}

export function incrementBookmarkClockOffline(db: DataDb, bookmarkId: string): void {
  try {
    const bookmark = db.select().from(bookmarks).where(eq(bookmarks.id, bookmarkId)).get()
    if (!bookmark) return

    const existingClock = (bookmark.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)

    db.update(bookmarks).set({ clock: newClock }).where(eq(bookmarks.id, bookmarkId)).run()

    log.debug('Incremented offline bookmark clock', { bookmarkId })
  } catch (err) {
    log.warn('Failed to increment offline bookmark clock', { bookmarkId, error: err })
  }
}

export function incrementReminderClockOffline(db: DataDb, reminderId: string): void {
  try {
    const reminder = db.select().from(reminders).where(eq(reminders.id, reminderId)).get()
    if (!reminder) return

    const existingClock = (reminder.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)

    db.update(reminders).set({ clock: newClock }).where(eq(reminders.id, reminderId)).run()

    log.debug('Incremented offline reminder clock', { reminderId })
  } catch (err) {
    log.warn('Failed to increment offline reminder clock', { reminderId, error: err })
  }
}

export function incrementCanvasClockOffline(db: DataDb, canvasId: string): void {
  try {
    const canvas = db.select().from(canvases).where(eq(canvases.id, canvasId)).get()
    if (!canvas) return

    const existingClock = (canvas.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)

    db.update(canvases).set({ clock: newClock }).where(eq(canvases.id, canvasId)).run()

    log.debug('Incremented offline canvas clock', { canvasId })
  } catch (err) {
    log.warn('Failed to increment offline canvas clock', { canvasId, error: err })
  }
}
