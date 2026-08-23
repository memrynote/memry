import { asc, eq } from 'drizzle-orm'
import { reminders } from '@memry/db-schema/data-schema'
import type { DrizzleDb as DataDb } from '@memry/db-schema/drizzle-db'
import { createId } from './ids.ts'
import type { ReminderTargetType, ReminderStatus } from '@memry/contracts/reminder-types'

export type { ReminderTargetType, ReminderStatus }

export interface ReminderRecord {
  id: string
  targetType: ReminderTargetType
  targetId: string
  remindAt: string
  anchorId: string | null
  highlightText: string | null
  highlightStart: number | null
  highlightEnd: number | null
  title: string | null
  note: string | null
  status: ReminderStatus
  triggeredAt: string | null
  dismissedAt: string | null
  snoozedUntil: string | null
  createdAt: string
  modifiedAt: string
}

export interface CreateReminderInput {
  /**
   * Explicit row id. Optional: only `note_date` reminders set it, because they
   * are derived from the note's date pills by a reconciler that runs on EVERY
   * device, so both devices must land on the SAME row (see
   * `noteDateReminderId`). Every other caller omits it and gets a generated id.
   */
  id?: string
  targetType: ReminderTargetType
  targetId: string
  remindAt: string
  anchorId?: string | null
  title?: string | null
  note?: string | null
  highlightText?: string | null
  highlightStart?: number | null
  highlightEnd?: number | null
}

export interface UpdateReminderInput {
  id: string
  remindAt?: string
  title?: string | null
  note?: string | null
}

export interface ListRemindersOptions {
  targetType?: ReminderTargetType
  targetId?: string
  status?: ReminderStatus | ReminderStatus[]
  fromDate?: string
  toDate?: string
  limit?: number
  offset?: number
}

export interface ReminderList {
  reminders: ReminderRecord[]
  total: number
  hasMore: boolean
}

export interface RemindersService {
  create(input: CreateReminderInput): Promise<ReminderRecord>
  update(input: UpdateReminderInput): Promise<ReminderRecord | null>
  get(id: string): Promise<ReminderRecord | null>
  list(options?: ListRemindersOptions): Promise<ReminderList>
  forTarget(targetType: ReminderTargetType, targetId: string): Promise<ReminderRecord[]>
  due(): Promise<ReminderRecord[]>
  upcoming(days?: number): Promise<ReminderRecord[]>
  countPending(): Promise<number>
  dismiss(id: string): Promise<ReminderRecord>
  bulkDismiss(ids: string[]): Promise<{ success: boolean; dismissedCount: number }>
  snooze(id: string, snoozeUntil: string): Promise<ReminderRecord>
  delete(id: string): Promise<boolean>
}

export interface RemindersServiceHooks {
  /**
   * Called after a reminder row is written. Desktop wires this to the sync
   * queue; `app-core` must not import desktop sync code directly (architecture
   * boundary). For 'delete', `snapshot` is the JSON row captured BEFORE
   * removal, with `triggeredAt` stripped (it is device-local — it records
   * that THIS device showed the OS notification, and must never sync).
   */
  onMutate?: (op: 'create' | 'update' | 'delete', id: string, snapshot?: string) => void
}

function nowIso(): string {
  return new Date().toISOString()
}

function toReminder(row: typeof reminders.$inferSelect): ReminderRecord {
  return {
    id: row.id,
    targetType: row.targetType as ReminderTargetType,
    targetId: row.targetId,
    remindAt: row.remindAt,
    anchorId: row.anchorId,
    highlightText: row.highlightText,
    highlightStart: row.highlightStart,
    highlightEnd: row.highlightEnd,
    title: row.title,
    note: row.note,
    status: row.status as ReminderStatus,
    triggeredAt: row.triggeredAt,
    dismissedAt: row.dismissedAt,
    snoozedUntil: row.snoozedUntil,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}

function matchesStatus(status: ReminderStatus, filter: ReminderStatus | ReminderStatus[]): boolean {
  return Array.isArray(filter) ? filter.includes(status) : status === filter
}

function activeReminder(reminder: ReminderRecord): boolean {
  return reminder.status === 'pending' || reminder.status === 'snoozed'
}

export function createRemindersService(
  dataDb: DataDb,
  hooks?: RemindersServiceHooks
): RemindersService {
  return {
    async create(input) {
      if (!input.targetId.trim()) throw new Error('Reminder target id is required')
      if (input.targetType === 'highlight' && !input.highlightText?.trim()) {
        throw new Error('Highlight reminders require --highlight-text')
      }

      const time = nowIso()
      const id = input.id ?? createId('reminder')
      dataDb
        .insert(reminders)
        .values({
          id,
          targetType: input.targetType,
          targetId: input.targetId,
          remindAt: input.remindAt,
          anchorId: input.anchorId ?? null,
          highlightText: input.highlightText ?? null,
          highlightStart: input.highlightStart ?? null,
          highlightEnd: input.highlightEnd ?? null,
          title: input.title ?? null,
          note: input.note ?? null,
          status: 'pending',
          createdAt: time,
          modifiedAt: time
        })
        .run()

      const reminder = await this.get(id)
      if (!reminder) throw new Error('Reminder not found after create')
      hooks?.onMutate?.('create', id)
      return reminder
    },

    async get(id) {
      const row = dataDb.select().from(reminders).where(eq(reminders.id, id)).get()
      return row ? toReminder(row) : null
    },

    async update(input) {
      const updates: Partial<typeof reminders.$inferInsert> = {
        modifiedAt: nowIso()
      }

      if (input.remindAt !== undefined) {
        updates.remindAt = input.remindAt
        updates.status = 'pending'
        updates.triggeredAt = null
        updates.snoozedUntil = null
      }
      if (input.title !== undefined) updates.title = input.title
      if (input.note !== undefined) updates.note = input.note

      const row = dataDb
        .update(reminders)
        .set(updates)
        .where(eq(reminders.id, input.id))
        .returning()
        .get()
      if (!row) return null
      hooks?.onMutate?.('update', row.id)
      return toReminder(row)
    },

    async list(options = {}) {
      const limit = options.limit ?? 50
      const offset = options.offset ?? 0
      const rows = dataDb.select().from(reminders).orderBy(asc(reminders.remindAt)).all()
      const filtered = rows
        .map(toReminder)
        .filter((reminder) => !options.targetType || reminder.targetType === options.targetType)
        .filter((reminder) => !options.targetId || reminder.targetId === options.targetId)
        .filter((reminder) => !options.status || matchesStatus(reminder.status, options.status))
        .filter((reminder) => !options.fromDate || reminder.remindAt >= options.fromDate)
        .filter((reminder) => !options.toDate || reminder.remindAt <= options.toDate)
      return {
        reminders: filtered.slice(offset, offset + limit),
        total: filtered.length,
        hasMore: offset + limit < filtered.length
      }
    },

    async forTarget(targetType, targetId) {
      return (await this.list({ targetType, targetId, limit: 1000 })).reminders
    },

    async due() {
      const current = nowIso()
      return (await this.list({ status: ['pending', 'snoozed'], limit: 1000 })).reminders.filter(
        (reminder) => {
          const dueAt = reminder.status === 'snoozed' ? reminder.snoozedUntil : reminder.remindAt
          return !!dueAt && dueAt <= current
        }
      )
    },

    async upcoming(days = 7) {
      const start = nowIso()
      const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
      return (await this.list({ status: ['pending', 'snoozed'], limit: 1000 })).reminders.filter(
        (reminder) =>
          activeReminder(reminder) && reminder.remindAt >= start && reminder.remindAt <= end
      )
    },

    async countPending() {
      return (await this.list({ status: ['pending', 'snoozed'], limit: 1000 })).total
    },

    async dismiss(id) {
      const time = nowIso()
      const row = dataDb
        .update(reminders)
        .set({ status: 'dismissed', dismissedAt: time, modifiedAt: time })
        .where(eq(reminders.id, id))
        .returning()
        .get()
      if (!row) throw new Error(`Reminder not found: ${id}`)
      hooks?.onMutate?.('update', row.id)
      return toReminder(row)
    },

    async bulkDismiss(ids) {
      let dismissedCount = 0
      for (const id of ids) {
        const time = nowIso()
        const row = dataDb
          .update(reminders)
          .set({ status: 'dismissed', dismissedAt: time, modifiedAt: time })
          .where(eq(reminders.id, id))
          .returning()
          .get()
        if (row) {
          dismissedCount += 1
          hooks?.onMutate?.('update', row.id)
        }
      }
      return { success: true, dismissedCount }
    },

    async snooze(id, snoozeUntil) {
      const time = nowIso()
      const row = dataDb
        .update(reminders)
        .set({ status: 'snoozed', snoozedUntil: snoozeUntil, modifiedAt: time })
        .where(eq(reminders.id, id))
        .returning()
        .get()
      if (!row) throw new Error(`Reminder not found: ${id}`)
      hooks?.onMutate?.('update', row.id)
      return toReminder(row)
    },

    async delete(id) {
      // Snapshot must be captured BEFORE the delete runs — reading the row
      // after deletion yields undefined, and the downstream enqueueDelete
      // no-ops on a falsy snapshot (the row would never sync and would
      // resurrect on the next pull). triggeredAt is device-local (this
      // device showed the OS notification) and must not sync.
      const row = dataDb.select().from(reminders).where(eq(reminders.id, id)).get()
      if (row) {
        const { triggeredAt: _triggeredAt, ...snapshot } = row
        hooks?.onMutate?.('delete', id, JSON.stringify(snapshot))
      }

      dataDb.delete(reminders).where(eq(reminders.id, id)).run()
      return true
    }
  }
}
