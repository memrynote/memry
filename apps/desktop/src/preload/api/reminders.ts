import { ReminderChannels } from '@memry/contracts/ipc-channels'
import { invoke, subscribe } from '../lib/ipc'
import type { MainIpcInvokeArgs } from '../../main/ipc/generated-ipc-invoke-map'

export const remindersApi = {
  create: (input: {
    targetType: 'note' | 'journal' | 'highlight'
    targetId: string
    remindAt: string
    title?: string
    note?: string
    highlightText?: string
    highlightStart?: number
    highlightEnd?: number
  }) =>
    invoke(
      ReminderChannels.invoke.CREATE,
      input as MainIpcInvokeArgs<typeof ReminderChannels.invoke.CREATE>[0]
    ),

  update: (input: { id: string; remindAt?: string; title?: string | null; note?: string | null }) =>
    invoke(ReminderChannels.invoke.UPDATE, input),

  delete: (id: string) => invoke(ReminderChannels.invoke.DELETE, id),

  get: (id: string) => invoke(ReminderChannels.invoke.GET, id),

  list: (options?: {
    targetType?: 'note' | 'journal' | 'highlight'
    targetId?: string
    status?: string | string[]
    fromDate?: string
    toDate?: string
    limit?: number
    offset?: number
  }) =>
    invoke(
      ReminderChannels.invoke.LIST,
      (options ?? {}) as MainIpcInvokeArgs<typeof ReminderChannels.invoke.LIST>[0]
    ),

  getUpcoming: (days?: number) => invoke(ReminderChannels.invoke.GET_UPCOMING, days),

  getDue: () => invoke(ReminderChannels.invoke.GET_DUE),

  getForTarget: (input: { targetType: 'note' | 'journal' | 'highlight'; targetId: string }) =>
    invoke(ReminderChannels.invoke.GET_FOR_TARGET, input),

  countPending: () => invoke(ReminderChannels.invoke.COUNT_PENDING),

  dismiss: (id: string) => invoke(ReminderChannels.invoke.DISMISS, id),

  snooze: (input: { id: string; snoozeUntil: string }) =>
    invoke(ReminderChannels.invoke.SNOOZE, input),

  bulkDismiss: (input: { reminderIds: string[] }) =>
    invoke(ReminderChannels.invoke.BULK_DISMISS, input)
}

export const reminderEvents = {
  onReminderCreated: (callback: (event: { reminder: unknown }) => void): (() => void) =>
    subscribe<{ reminder: unknown }>(ReminderChannels.events.CREATED, callback),

  onReminderUpdated: (callback: (event: { reminder: unknown }) => void): (() => void) =>
    subscribe<{ reminder: unknown }>(ReminderChannels.events.UPDATED, callback),

  onReminderDeleted: (
    callback: (event: { id: string; targetType: string; targetId: string }) => void
  ): (() => void) =>
    subscribe<{ id: string; targetType: string; targetId: string }>(
      ReminderChannels.events.DELETED,
      callback
    ),

  onReminderDue: (
    callback: (event: { reminders: unknown[]; count: number }) => void
  ): (() => void) =>
    subscribe<{ reminders: unknown[]; count: number }>(ReminderChannels.events.DUE, callback),

  onReminderDismissed: (callback: (event: { reminder: unknown }) => void): (() => void) =>
    subscribe<{ reminder: unknown }>(ReminderChannels.events.DISMISSED, callback),

  onReminderSnoozed: (callback: (event: { reminder: unknown }) => void): (() => void) =>
    subscribe<{ reminder: unknown }>(ReminderChannels.events.SNOOZED, callback),

  /** Subscribe to desktop notification click events — navigates to reminder target */
  onReminderClicked: (callback: (event: { reminder: unknown }) => void): (() => void) =>
    subscribe<{ reminder: unknown }>(ReminderChannels.events.CLICKED, callback)
}
