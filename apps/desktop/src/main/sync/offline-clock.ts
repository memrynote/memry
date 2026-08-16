import { eq } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { savedFilters } from '@memry/db-schema/schema/settings'
import { taskActivity } from '@memry/db-schema/schema/task-activity'
import { canvases } from '@memry/db-schema/schema/canvas'
import { canvasFolders } from '@memry/db-schema/schema/canvas-folder'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { reminders } from '@memry/db-schema/schema/reminders'
import { templates } from '@memry/db-schema/schema/templates'
import { homePages } from '@memry/db-schema/schema/home-pages'
import {
  OFFLINE_CLOCK_DEVICE_ID,
  type VectorClock,
  type FieldClocks
} from '@memry/contracts/sync-api'
import { increment } from './vector-clock'
import { getCurrentDeviceId } from './current-device-id'
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

    // Debug, and ids only. This fires once per field change for every task
    // edited while the sync runtime is down, and a leftover `info` line built a
    // fresh clock object per call that then rode the shipped-log queue.
    log.debug('Incremented offline task clocks', { taskId, changedFields })
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

/**
 * Note there is no rebinding hook for these the way task-sync.ts rebinds
 * offline task clocks: an activity row stamped `_offline` keeps that key for
 * its whole life. That is fine — the row is immutable, so the clock is never
 * compared against a later local edit.
 */
export function incrementTaskActivityClockOffline(db: DataDb, activityId: string): void {
  try {
    const row = db.select().from(taskActivity).where(eq(taskActivity.id, activityId)).get()
    if (!row) return

    const existingClock = (row.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)

    db.update(taskActivity).set({ clock: newClock }).where(eq(taskActivity.id, activityId)).run()

    log.debug('Incremented offline task activity clock', { activityId })
  } catch (err) {
    log.warn('Failed to increment offline task activity clock', { activityId, error: err })
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

export function incrementHomePageClockOffline(db: DataDb, boardId: string): void {
  try {
    const board = db.select().from(homePages).where(eq(homePages.id, boardId)).get()
    if (!board) return

    const existingClock = (board.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)

    db.update(homePages).set({ clock: newClock }).where(eq(homePages.id, boardId)).run()

    log.debug('Incremented offline home board clock', { boardId })
  } catch (err) {
    log.warn('Failed to increment offline home board clock', { boardId, error: err })
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

/**
 * Offline fallback for note metadata updates — the note counterpart of the
 * `increment*ClockOffline` helpers above, with two deliberate differences.
 *
 * Journals use it too: they are `note_metadata` rows like notes, share the
 * `clock`/`syncedAt`/`localOnly` columns this touches, and are re-pushed by
 * `recoverDirtyJournals` on the same `syncedAt` signal. Only the sweep that
 * picks the row up and the service that pushes it differ.
 *
 * 1. It bumps under the REAL device id, not `OFFLINE_DEVICE_KEY`. The record
 *    types park ticks under `_offline` because they can be edited with no
 *    device registered at all, and their sync services rebind those ticks on
 *    the way out (`recoverPendingChange` in task-sync/project-sync). Notes have
 *    no such rebinding hook — `ContentSyncService` pushes the stored clock
 *    verbatim — so an `_offline` tick would reach peers as a device entry two
 *    machines can both claim, and their clocks would then compare equal for
 *    edits that are actually concurrent. When no device is registered we do
 *    nothing, which is exactly what the online path already does (the
 *    controller drops the enqueue via `handleMissingDevice`).
 * 2. It clears `syncedAt` so `recoverDirtyItems` re-pushes the note at the next
 *    sync runtime start. A clock bump alone is invisible to that sweep: its
 *    dirty test is `modifiedAt > syncedAt`, and metadata-only writes such as
 *    `recordUploadedAttachment` never touch `modifiedAt` (updateNoteMetadata
 *    only stamps `storedAt`). `syncedAt = null` is also simply true here — the
 *    local row now holds state the server has not confirmed.
 *
 * The bump itself is load-bearing: the recovered push reuses the stored clock
 * without advancing it, so re-pushing at the acknowledged clock would be
 * replay-detected and peers would never see the new metadata.
 *
 * Backward compatible: no schema change. `clock` and `syncedAt` are existing
 * columns, `syncedAt` is already nullable and already means "never confirmed
 * synced" for notes created offline, and older builds treat such a row exactly
 * the same way (dirty-recovery is the only reader).
 */
export function incrementNoteClockOffline(db: DataDb, noteId: string): void {
  try {
    const note = db.select().from(noteMetadata).where(eq(noteMetadata.id, noteId)).get()
    if (!note) return
    // The user's "never leaves this device" switch — mirrors `shouldSkip` on
    // the online path.
    if (note.localOnly) return
    // No clock means the row has never been pushed; the unclocked seeds own its
    // first push (`seedUnclockedNotes` for notes, `journalHandler.seedUnclocked`
    // for journals) and would overwrite whatever we set here.
    if (!note.clock) return

    const deviceId = getCurrentDeviceId(db)
    if (!deviceId) {
      log.warn('No current device, skipping offline note clock bump', { noteId })
      return
    }

    const nextClock = increment(note.clock, deviceId)

    db.update(noteMetadata)
      .set({ clock: nextClock, syncedAt: null })
      .where(eq(noteMetadata.id, noteId))
      .run()

    log.debug('Incremented offline note clock', { noteId })
  } catch (err) {
    log.warn('Failed to increment offline note clock', { noteId, error: err })
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

export function incrementCanvasFolderClockOffline(db: DataDb, folderId: string): void {
  try {
    const folder = db.select().from(canvasFolders).where(eq(canvasFolders.id, folderId)).get()
    if (!folder) return

    const existingClock = (folder.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)

    db.update(canvasFolders).set({ clock: newClock }).where(eq(canvasFolders.id, folderId)).run()

    log.debug('Incremented offline canvas folder clock', { folderId })
  } catch (err) {
    log.warn('Failed to increment offline canvas folder clock', { folderId, error: err })
  }
}
