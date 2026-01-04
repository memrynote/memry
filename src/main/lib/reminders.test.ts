import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { InboxChannels } from '@shared/ipc-channels'
import { ReminderChannels } from '@shared/contracts/reminders-api'
import { inboxItems, inboxItemType } from '@shared/db/schema/inbox'
import { reminders, reminderStatus } from '@shared/db/schema/reminders'
import { noteCache } from '@shared/db/schema/notes-cache'
import {
  createTestDatabase,
  createTestIndexDb,
  cleanupTestDatabase,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { MockBrowserWindow } from '@tests/utils/mock-electron'
import { BrowserWindow } from 'electron'

type NotificationHandler = () => void

class TestNotification {
  static instances: TestNotification[] = []
  static isSupported = vi.fn(() => true)

  title: string
  body: string
  show = vi.fn()
  close = vi.fn()
  private handlers: Record<string, NotificationHandler | undefined> = {}

  constructor(options: { title: string; body: string }) {
    this.title = options.title
    this.body = options.body
    TestNotification.instances.push(this)
  }

  on = vi.fn((event: string, handler: NotificationHandler) => {
    this.handlers[event] = handler
    return this
  })

  trigger(event: string): void {
    this.handlers[event]?.()
  }
}

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn()
  },
  Notification: TestNotification
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn()
}))

import { getDatabase, getIndexDatabase } from '../database'
import {
  createReminder,
  updateReminder,
  deleteReminder,
  getReminder,
  listReminders,
  getRemindersForTarget,
  snoozeReminder,
  dismissReminder,
  startReminderScheduler,
  stopReminderScheduler,
  isSchedulerRunning
} from './reminders'

describe('reminders', () => {
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let window: MockBrowserWindow

  beforeEach(() => {
    dataDb = createTestDatabase()
    indexDb = createTestIndexDb()
    vi.mocked(getDatabase).mockReturnValue(dataDb.db)
    vi.mocked(getIndexDatabase).mockReturnValue(indexDb.db)

    window = new MockBrowserWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window])

    TestNotification.instances = []
    TestNotification.isSupported.mockReturnValue(true)
  })

  afterEach(() => {
    stopReminderScheduler()
    cleanupTestDatabase(dataDb)
    indexDb.close()
    TestNotification.instances = []
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  // ==========================================================================
  // T577: CRUD operations
  // ==========================================================================
  describe('CRUD operations', () => {
    it('creates a reminder and emits CREATED event', () => {
      const remindAt = new Date(Date.now() + 60_000).toISOString()
      const reminder = createReminder({
        targetType: 'note',
        targetId: 'note-1',
        remindAt,
        title: 'Follow up',
        note: 'Review this note'
      })

      expect(reminder.id).toMatch(/^rem_/)
      expect(reminder.status).toBe(reminderStatus.PENDING)
      expect(reminder.title).toBe('Follow up')
      expect(reminder.note).toBe('Review this note')

      expect(window.webContents.send).toHaveBeenCalledWith(
        ReminderChannels.events.CREATED,
        expect.objectContaining({
          reminder: expect.objectContaining({ id: reminder.id })
        })
      )
    })

    it('updates a reminder and emits UPDATED event', () => {
      const remindAt = new Date(Date.now() + 60_000).toISOString()
      const reminder = createReminder({
        targetType: 'note',
        targetId: 'note-2',
        remindAt
      })

      window.webContents.send.mockClear()

      const updatedAt = new Date(Date.now() + 120_000).toISOString()
      const updated = updateReminder({
        id: reminder.id,
        remindAt: updatedAt,
        title: 'Updated title'
      })

      expect(updated?.remindAt).toBe(updatedAt)
      expect(updated?.title).toBe('Updated title')
      expect(updated?.status).toBe(reminderStatus.PENDING)
      expect(updated?.triggeredAt).toBeNull()

      expect(window.webContents.send).toHaveBeenCalledWith(
        ReminderChannels.events.UPDATED,
        expect.objectContaining({
          reminder: expect.objectContaining({ id: reminder.id })
        })
      )
    })

    it('deletes a reminder and emits DELETED event', () => {
      const remindAt = new Date(Date.now() + 60_000).toISOString()
      const reminder = createReminder({
        targetType: 'note',
        targetId: 'note-3',
        remindAt
      })

      window.webContents.send.mockClear()

      const deleted = deleteReminder(reminder.id)
      expect(deleted).toBe(true)
      expect(getReminder(reminder.id)).toBeNull()

      expect(window.webContents.send).toHaveBeenCalledWith(
        ReminderChannels.events.DELETED,
        expect.objectContaining({
          id: reminder.id,
          targetType: 'note',
          targetId: 'note-3'
        })
      )
    })

    it('returns null for missing reminders', () => {
      expect(getReminder('missing')).toBeNull()
      expect(updateReminder({ id: 'missing', title: 'Nope' })).toBeNull()
      expect(deleteReminder('missing')).toBe(false)
    })
  })

  // ==========================================================================
  // T578: list queries and filters
  // ==========================================================================
  describe('list queries', () => {
    beforeEach(() => {
      const baseTime = '2025-01-10T10:00:00.000Z'
      const rows: Array<typeof reminders.$inferInsert> = [
        {
          id: 'rem-1',
          targetType: 'note',
          targetId: 'note-1',
          remindAt: baseTime,
          status: reminderStatus.PENDING,
          createdAt: baseTime,
          modifiedAt: baseTime
        },
        {
          id: 'rem-2',
          targetType: 'note',
          targetId: 'note-2',
          remindAt: '2025-01-11T10:00:00.000Z',
          status: reminderStatus.SNOOZED,
          snoozedUntil: '2025-01-12T10:00:00.000Z',
          createdAt: baseTime,
          modifiedAt: baseTime
        },
        {
          id: 'rem-3',
          targetType: 'journal',
          targetId: '2025-01-12',
          remindAt: '2025-01-12T10:00:00.000Z',
          status: reminderStatus.DISMISSED,
          dismissedAt: '2025-01-12T12:00:00.000Z',
          createdAt: baseTime,
          modifiedAt: baseTime
        }
      ]

      dataDb.db.insert(reminders).values(rows).run()
    })

    it('lists reminders with pagination and totals', () => {
      const result = listReminders({ limit: 1, offset: 1 })
      expect(result.total).toBe(3)
      expect(result.reminders).toHaveLength(1)
      expect(result.hasMore).toBe(true)
    })

    it('filters by status and target', () => {
      const statusResult = listReminders({
        status: [reminderStatus.PENDING, reminderStatus.SNOOZED]
      })
      expect(statusResult.total).toBe(2)

      const targetResult = listReminders({ targetType: 'note', targetId: 'note-2' })
      expect(targetResult.total).toBe(1)
      expect(targetResult.reminders[0]?.id).toBe('rem-2')
    })

    it('filters by date range and returns target reminders', () => {
      const rangeResult = listReminders({
        fromDate: '2025-01-11T00:00:00.000Z',
        toDate: '2025-01-12T23:59:59.000Z'
      })
      expect(rangeResult.total).toBe(2)

      const targetReminders = getRemindersForTarget('note', 'note-1')
      expect(targetReminders).toHaveLength(1)
      expect(targetReminders[0]?.id).toBe('rem-1')
    })
  })

  // ==========================================================================
  // T580: snooze/dismiss flows + event emission
  // ==========================================================================
  describe('snooze and dismiss', () => {
    it('snoozes reminder and emits SNOOZED event', () => {
      const remindAt = new Date(Date.now() + 60_000).toISOString()
      const reminder = createReminder({
        targetType: 'note',
        targetId: 'note-4',
        remindAt
      })

      window.webContents.send.mockClear()

      const snoozeUntil = new Date(Date.now() + 120_000).toISOString()
      const snoozed = snoozeReminder({ id: reminder.id, snoozeUntil })

      expect(snoozed?.status).toBe(reminderStatus.SNOOZED)
      expect(snoozed?.snoozedUntil).toBe(snoozeUntil)

      expect(window.webContents.send).toHaveBeenCalledWith(
        ReminderChannels.events.SNOOZED,
        expect.objectContaining({
          reminder: expect.objectContaining({ id: reminder.id })
        })
      )
    })

    it('dismisses reminder and emits DISMISSED event', () => {
      const remindAt = new Date(Date.now() + 60_000).toISOString()
      const reminder = createReminder({
        targetType: 'note',
        targetId: 'note-5',
        remindAt
      })

      window.webContents.send.mockClear()

      const dismissed = dismissReminder(reminder.id)

      expect(dismissed?.status).toBe(reminderStatus.DISMISSED)
      expect(dismissed?.dismissedAt).toBeTruthy()

      expect(window.webContents.send).toHaveBeenCalledWith(
        ReminderChannels.events.DISMISSED,
        expect.objectContaining({
          reminder: expect.objectContaining({ id: reminder.id })
        })
      )
    })
  })

  // ==========================================================================
  // T579 + T581: scheduler lifecycle, due processing, inbox + notification flow
  // ==========================================================================
  describe('scheduler and due processing', () => {
    it('processes due reminders, creates inbox items, and handles notification clicks', () => {
      vi.useFakeTimers()
      const now = new Date('2025-01-10T10:00:00.000Z')
      vi.setSystemTime(now)
      const nowIso = new Date().toISOString()

      indexDb.db.insert(noteCache).values({
        id: 'note-10',
        path: '/vault/notes/note-10.md',
        title: 'Note 10',
        contentHash: 'hash-10',
        createdAt: nowIso,
        modifiedAt: nowIso
      }).run()

      dataDb.db.insert(reminders).values({
        id: 'rem-due',
        targetType: 'note',
        targetId: 'note-10',
        remindAt: nowIso,
        status: reminderStatus.PENDING,
        createdAt: nowIso,
        modifiedAt: nowIso
      }).run()

      window.minimize()

      startReminderScheduler()

      expect(isSchedulerRunning()).toBe(true)

      const updated = dataDb.db
        .select()
        .from(reminders)
        .where(eq(reminders.id, 'rem-due'))
        .get()
      expect(updated?.status).toBe(reminderStatus.TRIGGERED)
      expect(updated?.triggeredAt).toBe(nowIso)

      const inboxItem = dataDb.db
        .select()
        .from(inboxItems)
        .where(eq(inboxItems.type, inboxItemType.REMINDER))
        .get()
      expect(inboxItem).toBeDefined()
      expect(inboxItem?.title).toBe('Note 10')
      expect((inboxItem?.metadata as { reminderId?: string } | null)?.reminderId).toBe(
        'rem-due'
      )

      const sentChannels = window.webContents.send.mock.calls.map(([channel]) => channel)
      expect(sentChannels).toEqual(
        expect.arrayContaining([ReminderChannels.events.DUE, InboxChannels.events.CAPTURED])
      )

      expect(TestNotification.instances).toHaveLength(1)
      const notification = TestNotification.instances[0]
      expect(notification.show).toHaveBeenCalled()

      notification.trigger('click')

      expect(window.restore).toHaveBeenCalled()
      expect(window.focus).toHaveBeenCalled()
      expect(window.webContents.send).toHaveBeenCalledWith(
        ReminderChannels.events.CLICKED,
        expect.objectContaining({
          reminder: expect.objectContaining({ id: 'rem-due' })
        })
      )
    })

    it('stops the scheduler', () => {
      vi.useFakeTimers()
      startReminderScheduler()
      expect(isSchedulerRunning()).toBe(true)

      stopReminderScheduler()
      expect(isSchedulerRunning()).toBe(false)
    })
  })
})
