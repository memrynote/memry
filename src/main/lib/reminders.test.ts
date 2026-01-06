/**
 * Reminder service tests
 *
 * @module main/lib/reminders.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { reminders, reminderStatus } from '@shared/db/schema/reminders'
import { inboxItems } from '@shared/db/schema/inbox'
import { noteCache } from '@shared/db/schema/notes-cache'
import { InboxChannels, ReminderChannels } from '@shared/ipc-channels'
import {
  createTestDatabase,
  createTestIndexDb,
  cleanupTestDatabase,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { MockBrowserWindow } from '@tests/utils/mock-electron'

const notificationInstances: MockNotification[] = []

class MockNotification {
  static isSupported = vi.fn(() => true)
  options: { title: string; body: string; silent?: boolean }
  handlers: Record<string, () => void> = {}
  show = vi.fn()
  close = vi.fn()

  constructor(options: { title: string; body: string; silent?: boolean }) {
    this.options = options
    notificationInstances.push(this)
  }

  on(event: string, handler: () => void): this {
    this.handlers[event] = handler
    return this
  }

  once(event: string, handler: () => void): this {
    this.handlers[event] = handler
    return this
  }

  emit(event: string): void {
    this.handlers[event]?.()
  }
}

let remindersService: typeof import('./reminders')
let getDatabase: typeof import('../database').getDatabase
let getIndexDatabase: typeof import('../database').getIndexDatabase
let BrowserWindow: typeof import('electron').BrowserWindow

describe('reminders service', () => {
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let window: MockBrowserWindow
  let reminderCounter = 0

  const seedReminder = (overrides: Partial<typeof reminders.$inferInsert> = {}): string => {
    reminderCounter += 1
    const baseTimestamp = '2025-01-01T00:00:00.000Z'
    const reminder: typeof reminders.$inferInsert = {
      id: `rem-${reminderCounter}`,
      targetType: 'note',
      targetId: 'note-1',
      remindAt: baseTimestamp,
      status: reminderStatus.PENDING,
      title: null,
      note: null,
      highlightText: null,
      highlightStart: null,
      highlightEnd: null,
      createdAt: baseTimestamp,
      modifiedAt: baseTimestamp,
      ...overrides
    }

    dataDb.db.insert(reminders).values(reminder).run()
    return reminder.id as string
  }

  const seedNoteCache = (id: string, title: string): void => {
    const now = '2025-01-01T00:00:00.000Z'
    indexDb.db.insert(noteCache).values({
      id,
      path: `notes/${id}.md`,
      title,
      contentHash: 'hash',
      wordCount: 0,
      characterCount: 0,
      createdAt: now,
      modifiedAt: now
    }).run()
  }

  beforeEach(async () => {
    notificationInstances.length = 0
    MockNotification.isSupported.mockReset()
    MockNotification.isSupported.mockReturnValue(true)
    reminderCounter = 0

    vi.resetModules()
    vi.doMock('electron', () => ({
      BrowserWindow: {
        getAllWindows: vi.fn()
      },
      Notification: MockNotification
    }))
    vi.doMock('../database', () => ({
      getDatabase: vi.fn(),
      getIndexDatabase: vi.fn()
    }))

    const databaseModule = await import('../database')
    getDatabase = databaseModule.getDatabase
    getIndexDatabase = databaseModule.getIndexDatabase

    const electronModule = await import('electron')
    BrowserWindow = electronModule.BrowserWindow

    remindersService = await import('./reminders')

    dataDb = createTestDatabase()
    indexDb = createTestIndexDb()
    vi.mocked(getDatabase).mockReturnValue(dataDb.db)
    vi.mocked(getIndexDatabase).mockReturnValue(indexDb.db)

    window = new MockBrowserWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window])
  })

  afterEach(() => {
    remindersService.stopReminderScheduler()
    cleanupTestDatabase(dataDb)
    cleanupTestDatabase(indexDb)
    vi.clearAllMocks()
  })

  it('filters reminders by status and date range', () => {
    seedReminder({
      id: 'rem-1',
      remindAt: '2025-01-10T09:00:00.000Z',
      status: reminderStatus.PENDING
    })
    seedReminder({
      id: 'rem-2',
      remindAt: '2025-01-11T09:00:00.000Z',
      status: reminderStatus.DISMISSED
    })
    seedReminder({
      id: 'rem-3',
      remindAt: '2025-01-12T09:00:00.000Z',
      status: reminderStatus.SNOOZED
    })
    seedReminder({
      id: 'rem-4',
      remindAt: '2025-02-01T09:00:00.000Z',
      status: reminderStatus.PENDING
    })

    const pending = remindersService.listReminders({ status: reminderStatus.PENDING })
    expect(pending.reminders.map((reminder) => reminder.id)).toEqual(['rem-1', 'rem-4'])
    expect(pending.total).toBe(2)
    expect(pending.hasMore).toBe(false)

    const january = remindersService.listReminders({
      fromDate: '2025-01-11T00:00:00.000Z',
      toDate: '2025-01-31T23:59:59.999Z'
    })
    expect(january.reminders.map((reminder) => reminder.id)).toEqual(['rem-2', 'rem-3'])

    const combined = remindersService.listReminders({
      status: [reminderStatus.PENDING, reminderStatus.SNOOZED],
      fromDate: '2025-01-10T00:00:00.000Z',
      toDate: '2025-01-31T23:59:59.999Z'
    })
    expect(combined.reminders.map((reminder) => reminder.id)).toEqual(['rem-1', 'rem-3'])
  })

  it('returns reminders for a target ordered by remindAt', () => {
    seedReminder({
      id: 'rem-a',
      targetType: 'note',
      targetId: 'note-1',
      remindAt: '2025-02-01T09:00:00.000Z'
    })
    seedReminder({
      id: 'rem-b',
      targetType: 'note',
      targetId: 'note-1',
      remindAt: '2025-01-15T09:00:00.000Z'
    })
    seedReminder({
      id: 'rem-c',
      targetType: 'journal',
      targetId: '2025-01-15',
      remindAt: '2025-01-16T09:00:00.000Z'
    })

    const results = remindersService.getRemindersForTarget('note', 'note-1')
    expect(results.map((reminder) => reminder.id)).toEqual(['rem-b', 'rem-a'])
    expect(results.every((reminder) => reminder.targetType === 'note')).toBe(true)
  })

  it('snoozes a reminder and emits a snoozed event', () => {
    seedReminder({
      id: 'rem-s1',
      remindAt: '2025-01-20T09:00:00.000Z',
      status: reminderStatus.PENDING
    })

    const snoozeUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const result = remindersService.snoozeReminder({ id: 'rem-s1', snoozeUntil })

    expect(result?.status).toBe(reminderStatus.SNOOZED)
    expect(result?.snoozedUntil).toBe(snoozeUntil)

    const stored = dataDb.db.select().from(reminders).where(eq(reminders.id, 'rem-s1')).get()
    expect(stored?.status).toBe(reminderStatus.SNOOZED)
    expect(stored?.snoozedUntil).toBe(snoozeUntil)

    expect(window.webContents.send).toHaveBeenCalledWith(
      ReminderChannels.events.SNOOZED,
      expect.objectContaining({
        reminder: expect.objectContaining({ id: 'rem-s1', snoozedUntil: snoozeUntil })
      })
    )
  })

  it('dismisses a reminder and emits a dismissed event', () => {
    seedReminder({
      id: 'rem-d1',
      remindAt: '2025-01-22T09:00:00.000Z',
      status: reminderStatus.PENDING
    })

    const result = remindersService.dismissReminder('rem-d1')

    expect(result?.status).toBe(reminderStatus.DISMISSED)

    const stored = dataDb.db.select().from(reminders).where(eq(reminders.id, 'rem-d1')).get()
    expect(stored?.status).toBe(reminderStatus.DISMISSED)
    expect(stored?.dismissedAt).toBeTruthy()

    expect(window.webContents.send).toHaveBeenCalledWith(
      ReminderChannels.events.DISMISSED,
      expect.objectContaining({
        reminder: expect.objectContaining({ id: 'rem-d1', status: reminderStatus.DISMISSED })
      })
    )
  })

  it('creates an inbox item and sends click navigation for due reminders', () => {
    seedNoteCache('note-1', 'Focus Note')
    seedReminder({
      id: 'rem-due',
      targetType: 'note',
      targetId: 'note-1',
      remindAt: '2000-01-01T00:00:00.000Z',
      note: 'Review this note',
      status: reminderStatus.PENDING
    })

    window.minimize()

    remindersService.startReminderScheduler()
    remindersService.stopReminderScheduler()

    expect(notificationInstances).toHaveLength(1)
    const notification = notificationInstances[0]
    expect(notification?.options.title).toContain('Focus Note')
    expect(notification?.show).toHaveBeenCalled()

    const inboxRow = dataDb.db
      .select()
      .from(inboxItems)
      .all()
      .find((item) => item.type === 'reminder')

    expect(inboxRow).toBeDefined()
    expect(inboxRow?.title).toBe('Focus Note')
    expect(inboxRow?.content).toBe('Review this note')
    expect(inboxRow?.metadata).toEqual(
      expect.objectContaining({
        reminderId: 'rem-due',
        targetType: 'note',
        targetId: 'note-1',
        targetTitle: 'Focus Note'
      })
    )

    expect(window.webContents.send).toHaveBeenCalledWith(
      InboxChannels.events.CAPTURED,
      expect.objectContaining({
        item: expect.objectContaining({ id: inboxRow?.id, type: 'reminder' })
      })
    )

    notification.emit('click')

    expect(window.restore).toHaveBeenCalled()
    expect(window.focus).toHaveBeenCalled()
    expect(window.webContents.send).toHaveBeenCalledWith(
      ReminderChannels.events.CLICKED,
      expect.objectContaining({
        reminder: expect.objectContaining({ id: 'rem-due' })
      })
    )

    const updated = dataDb.db.select().from(reminders).where(eq(reminders.id, 'rem-due')).get()
    expect(updated?.status).toBe(reminderStatus.TRIGGERED)
  })
})
