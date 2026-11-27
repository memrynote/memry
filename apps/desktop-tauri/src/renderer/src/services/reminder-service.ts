/**
 * Reminder Service
 *
 * The reminder commands of Step 21f2 (`commands/reminders.rs`) in the shapes of Electron's
 * `reminder:*` channels: a write answers `{ success, reminder }`, or `{ success: false, error }`
 * when the command throws. The events carry the reminder's id and target; the due and clicked
 * events are answered with the reminders read back by id, as Electron sends them.
 *
 * @module services/reminder-service
 */

import type {
  BulkDismissResponse,
  CreateReminderInput,
  ListRemindersInput as ListRemindersSchemaInput,
  Reminder,
  ReminderCreateResponse,
  ReminderDeleteResponse,
  ReminderDismissResponse,
  ReminderDueEvent,
  ReminderListResponse,
  ReminderSnoozeResponse,
  ReminderTargetType,
  ReminderUpdateResponse,
  ReminderWithTarget,
  SnoozeReminderInput,
  UpdateReminderInput
} from '@memry/contracts/reminders-api'
import {
  commands,
  events,
  type ReminderCreatedEvent,
  type ReminderDeletedEvent,
  type ReminderDismissedEvent,
  type ReminderHint,
  type ReminderListView,
  type ReminderSnoozedEvent,
  type ReminderUpdatedEvent,
  type ReminderView,
  type ReminderWithTargetView
} from '../../../generated/bindings'
import { extractErrorMessage } from '../lib/ipc-error'
import { createLogger } from '../lib/logger'
import { subscribeToEvent } from './tauri-event'

const log = createLogger('ReminderService')

/** Electron's `listReminders` takes the schema's fields, each optional. */
export type ListRemindersInput = Partial<ListRemindersSchemaInput>

export interface ReminderClickedEvent {
  reminder: ReminderWithTarget
}

export type {
  Reminder,
  ReminderWithTarget,
  CreateReminderInput,
  UpdateReminderInput,
  SnoozeReminderInput,
  ReminderListResponse,
  ReminderCreateResponse,
  ReminderUpdateResponse,
  ReminderDeleteResponse,
  ReminderDismissResponse,
  ReminderSnoozeResponse,
  BulkDismissResponse,
  ReminderTargetType,
  ReminderCreatedEvent,
  ReminderUpdatedEvent,
  ReminderDeletedEvent,
  ReminderDueEvent,
  ReminderDismissedEvent,
  ReminderSnoozedEvent
}

function toReminder(view: ReminderView): Reminder {
  return {
    ...view,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- carried verbatim from the row; its writers constrain it to the union
    targetType: view.targetType as ReminderTargetType,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- carried verbatim from the row; its writers constrain it to the union
    status: view.status as Reminder['status']
  }
}

function toReminderWithTarget(view: ReminderWithTargetView): ReminderWithTarget {
  return {
    ...toReminder(view),
    targetTitle: view.targetTitle,
    targetExists: view.targetExists,
    highlightExists: view.highlightExists ?? undefined,
    projectId: view.projectId
  }
}

function toListResponse(view: ReminderListView): ReminderListResponse {
  return { ...view, reminders: view.reminders.map(toReminderWithTarget) }
}

function failure(error: unknown): string | undefined {
  return extractErrorMessage(error, '') || undefined
}

async function written(write: () => Promise<ReminderView>): Promise<ReminderCreateResponse> {
  try {
    return { success: true, reminder: toReminder(await write()) }
  } catch (error) {
    return { success: false, reminder: null, error: failure(error) }
  }
}

/** The reminders `hints` name that are still there, read back by id. */
async function readBack(hints: ReminderHint[]): Promise<ReminderWithTarget[]> {
  const views = await Promise.all(hints.map((hint) => commands.reminderGet(hint.id)))
  return views.flatMap((view) => (view ? [toReminderWithTarget(view)] : []))
}

/** `callback` with what `resolve` reads for each event, until unsubscribed. */
function subscribeResolved<T, R>(
  event: { listen: (handler: (event: { payload: T }) => void) => Promise<() => void> },
  resolve: (payload: T) => Promise<R | null>,
  callback: (resolved: R) => void
): () => void {
  let active = true
  const deliver = async (payload: T): Promise<void> => {
    try {
      const resolved = await resolve(payload)
      if (active && resolved) callback(resolved)
    } catch (error) {
      log.warn('could not read the reminders of an event', error)
    }
  }
  const unsubscribe = subscribeToEvent(event, (payload) => void deliver(payload))
  return () => {
    active = false
    unsubscribe()
  }
}

export const reminderService = {
  create: (input: CreateReminderInput): Promise<ReminderCreateResponse> =>
    written(() => commands.reminderCreate(input)),

  update: (input: UpdateReminderInput): Promise<ReminderUpdateResponse> =>
    written(() => commands.reminderUpdate(input)),

  delete: async (id: string): Promise<ReminderDeleteResponse> => {
    try {
      await commands.reminderDelete(id)
      return { success: true }
    } catch (error) {
      return { success: false, error: failure(error) }
    }
  },

  get: async (id: string): Promise<ReminderWithTarget | null> => {
    const view = await commands.reminderGet(id)
    return view ? toReminderWithTarget(view) : null
  },

  list: async (options?: ListRemindersInput): Promise<ReminderListResponse> =>
    toListResponse(await commands.reminderList(options ?? null)),

  /** Pending and snoozed reminders of the next `days` days (7 when absent). */
  getUpcoming: async (days?: number): Promise<ReminderListResponse> =>
    toListResponse(await commands.reminderGetUpcoming(days ?? null)),

  getDue: async (): Promise<ReminderWithTarget[]> =>
    (await commands.reminderGetDue()).map(toReminderWithTarget),

  getForTarget: async (targetType: ReminderTargetType, targetId: string): Promise<Reminder[]> =>
    (await commands.reminderGetForTarget({ targetType, targetId })).map(toReminder),

  countPending: (): Promise<number> => commands.reminderCountPending(),

  dismiss: (id: string): Promise<ReminderDismissResponse> =>
    written(() => commands.reminderDismiss(id)),

  snooze: (input: SnoozeReminderInput): Promise<ReminderSnoozeResponse> =>
    written(() => commands.reminderSnooze(input)),

  bulkDismiss: async (reminderIds: string[]): Promise<BulkDismissResponse> => {
    try {
      return { success: true, dismissedCount: await commands.reminderBulkDismiss(reminderIds) }
    } catch (error) {
      return { success: false, dismissedCount: 0, error: failure(error) }
    }
  }
}

export async function createNoteReminder(
  noteId: string,
  remindAt: string,
  options?: { title?: string; note?: string }
): Promise<ReminderCreateResponse> {
  return reminderService.create({
    targetType: 'note',
    targetId: noteId,
    remindAt,
    title: options?.title,
    note: options?.note
  })
}

export async function createJournalReminder(
  journalDate: string,
  remindAt: string,
  options?: { title?: string; note?: string }
): Promise<ReminderCreateResponse> {
  return reminderService.create({
    targetType: 'journal',
    targetId: journalDate,
    remindAt,
    title: options?.title,
    note: options?.note
  })
}

export function onReminderCreated(callback: (event: ReminderCreatedEvent) => void): () => void {
  return subscribeToEvent(events.reminderCreatedEvent, callback)
}

export function onReminderUpdated(callback: (event: ReminderUpdatedEvent) => void): () => void {
  return subscribeToEvent(events.reminderUpdatedEvent, callback)
}

export function onReminderDeleted(callback: (event: ReminderDeletedEvent) => void): () => void {
  return subscribeToEvent(events.reminderDeletedEvent, callback)
}

export function onReminderDismissed(callback: (event: ReminderDismissedEvent) => void): () => void {
  return subscribeToEvent(events.reminderDismissedEvent, callback)
}

export function onReminderSnoozed(callback: (event: ReminderSnoozedEvent) => void): () => void {
  return subscribeToEvent(events.reminderSnoozedEvent, callback)
}

/** A scheduler tick fired reminders: each one that is still there, with its target. */
export function onReminderDue(callback: (event: ReminderDueEvent) => void): () => void {
  return subscribeResolved(
    events.reminderDueEvent,
    async ({ reminders: hints, count }) => {
      const reminders = await readBack(hints)
      return reminders.length > 0 ? { reminders, count } : null
    },
    callback
  )
}

/** A scheduler tick fired reminders: their ids and targets as the event names them, not read back. */
export function onRemindersFired(callback: (reminders: ReminderHint[]) => void): () => void {
  return subscribeToEvent(events.reminderDueEvent, ({ reminders }) => callback(reminders))
}

/**
 * A pull applied a reminder another device changed: Electron's sync handler sends `{ id }` on
 * the created, updated and deleted channels (`reminder-handler.ts`).
 */
export function onReminderSynced(callback: (event: { id: string }) => void): () => void {
  return subscribeToEvent(events.syncItemSyncedEvent, ({ operation, items }) => {
    if (operation !== 'pull') return
    for (const item of items) if (item.type === 'reminder') callback({ id: item.itemId })
  })
}

/** The user clicked a reminder's notification. */
export function onReminderClicked(callback: (event: ReminderClickedEvent) => void): () => void {
  return subscribeResolved(
    events.reminderClickedEvent,
    async ({ reminder }) => {
      const [found] = await readBack([reminder])
      return found ? { reminder: found } : null
    },
    callback
  )
}
