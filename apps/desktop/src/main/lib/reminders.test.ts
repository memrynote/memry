/**
 * Reminder service tests
 *
 * @module main/lib/reminders.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { reminders } from '@memry/db-schema/schema/reminders'
import { reminderStatus } from '@memry/contracts/reminders-api'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { InboxChannels, ReminderChannels } from '@memry/contracts/ipc-channels'
import {
  createTestDatabase,
  createTestIndexDb,
  cleanupTestDatabase,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { MockBrowserWindow } from '@tests/utils/mock-electron'

const { emitCalendarProjectionChanged, scheduleGoogleCalendarSourceSync } = vi.hoisted(() => ({
  emitCalendarProjectionChanged: vi.fn(),
  scheduleGoogleCalendarSourceSync: vi.fn()
}))

vi.mock('../calendar/change-events', () => ({
  emitCalendarProjectionChanged
}))

vi.mock('../calendar/google/local-sync-effects', () => ({
  scheduleGoogleCalendarSourceSync
}))

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
    return reminder.id
  }

  const seedNoteCache = (id: string, title: string): void => {
    const now = '2025-01-01T00:00:00.000Z'
    indexDb.db
      .insert(noteCache)
      .values({
        id,
        path: `notes/${id}.md`,
        title,
        contentHash: 'hash',
        wordCount: 0,
        characterCount: 0,
        createdAt: now,
        modifiedAt: now
      })
      .run()
  }

  beforeEach(async () => {
    notificationInstances.length = 0
    MockNotification.isSupported.mockReset()
    MockNotification.isSupported.mockReturnValue(true)
    reminderCounter = 0
    emitCalendarProjectionChanged.mockClear()
    scheduleGoogleCalendarSourceSync.mockClear()

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
    vi.doMock('../vault', () => ({
      getStatus: vi.fn(() => ({
        isOpen: true,
        path: '/test-vault',
        isIndexing: false,
        indexProgress: 0,
        error: null
      }))
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
    expect(emitCalendarProjectionChanged).toHaveBeenCalledWith('reminder:rem-s1')
    expect(scheduleGoogleCalendarSourceSync).toHaveBeenCalledWith({
      sourceType: 'reminder',
      sourceId: 'rem-s1'
    })
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
    expect(emitCalendarProjectionChanged).toHaveBeenCalledWith('reminder:rem-d1')
    expect(scheduleGoogleCalendarSourceSync).toHaveBeenCalledWith({
      sourceType: 'reminder',
      sourceId: 'rem-d1'
    })
  })

  it('creates, updates, and deletes reminders while notifying calendar projection state', () => {
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const created = remindersService.createReminder({
      targetType: 'note',
      targetId: 'note-1',
      remindAt: futureDate,
      title: 'Plan review',
      note: 'Bring notes'
    })

    expect(emitCalendarProjectionChanged).toHaveBeenCalledWith(`reminder:${created.id}`)
    expect(scheduleGoogleCalendarSourceSync).toHaveBeenCalledWith({
      sourceType: 'reminder',
      sourceId: created.id
    })

    emitCalendarProjectionChanged.mockClear()
    scheduleGoogleCalendarSourceSync.mockClear()

    const updated = remindersService.updateReminder({
      id: created.id,
      title: 'Updated plan review'
    })

    expect(updated?.title).toBe('Updated plan review')
    expect(emitCalendarProjectionChanged).toHaveBeenCalledWith(`reminder:${created.id}`)
    expect(scheduleGoogleCalendarSourceSync).toHaveBeenCalledWith({
      sourceType: 'reminder',
      sourceId: created.id
    })

    emitCalendarProjectionChanged.mockClear()
    scheduleGoogleCalendarSourceSync.mockClear()

    expect(remindersService.deleteReminder(created.id)).toBe(true)
    expect(emitCalendarProjectionChanged).toHaveBeenCalledWith(`reminder:${created.id}`)
    expect(scheduleGoogleCalendarSourceSync).toHaveBeenCalledWith({
      sourceType: 'reminder',
      sourceId: created.id
    })
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
    expect(emitCalendarProjectionChanged).toHaveBeenCalledWith('reminder:rem-due')
    expect(scheduleGoogleCalendarSourceSync).toHaveBeenCalledWith({
      sourceType: 'reminder',
      sourceId: 'rem-due'
    })
  })

  it('bulk dismisses reminders and notifies calendar projection state for each changed row', () => {
    seedReminder({
      id: 'rem-b1',
      remindAt: '2025-01-22T09:00:00.000Z',
      status: reminderStatus.PENDING
    })
    seedReminder({
      id: 'rem-b2',
      remindAt: '2025-01-23T09:00:00.000Z',
      status: reminderStatus.PENDING
    })

    const dismissed = remindersService.bulkDismissReminders(['rem-b1', 'rem-b2', 'missing'])

    expect(dismissed).toBe(2)
    expect(emitCalendarProjectionChanged).toHaveBeenCalledWith('reminder:rem-b1')
    expect(emitCalendarProjectionChanged).toHaveBeenCalledWith('reminder:rem-b2')
    expect(scheduleGoogleCalendarSourceSync).toHaveBeenCalledWith({
      sourceType: 'reminder',
      sourceId: 'rem-b1'
    })
    expect(scheduleGoogleCalendarSourceSync).toHaveBeenCalledWith({
      sourceType: 'reminder',
      sourceId: 'rem-b2'
    })
  })

  describe('target title resolution', () => {
    it('resolves note title from noteCache for note reminders', () => {
      // #given
      seedNoteCache('note-42', 'Quarterly Review')
      const id = seedReminder({ targetType: 'note', targetId: 'note-42' })

      // #when
      const reminder = remindersService.getReminder(id)

      // #then
      expect(reminder).not.toBeNull()
      expect(reminder?.targetTitle).toBe('Quarterly Review')
      expect(reminder?.targetExists).toBe(true)
      expect(reminder?.highlightExists).toBeUndefined()
    })

    it('uses targetId as title for journal reminders without hitting the index db', () => {
      // #given
      const id = seedReminder({ targetType: 'journal', targetId: '2026-04-16' })

      // #when
      const reminder = remindersService.getReminder(id)

      // #then
      expect(reminder?.targetTitle).toBe('2026-04-16')
      expect(reminder?.targetExists).toBe(true)
      expect(reminder?.highlightExists).toBeUndefined()
    })

    it('marks note reminders missing from the cache as non-existent', () => {
      // #given — no seedNoteCache call for this id
      const id = seedReminder({ targetType: 'note', targetId: 'note-gone' })

      // #when
      const reminder = remindersService.getReminder(id)

      // #then
      expect(reminder?.targetTitle).toBeNull()
      expect(reminder?.targetExists).toBe(false)
    })

    it('sets highlightExists for highlight reminders when the underlying note is present', () => {
      // #given
      seedNoteCache('note-h1', 'Annotated Essay')
      const id = seedReminder({
        targetType: 'highlight',
        targetId: 'note-h1',
        highlightText: 'key passage',
        highlightStart: 0,
        highlightEnd: 11
      })

      // #when
      const reminder = remindersService.getReminder(id)

      // #then
      expect(reminder?.targetTitle).toBe('Annotated Essay')
      expect(reminder?.targetExists).toBe(true)
      expect(reminder?.highlightExists).toBe(true)
    })

    it('clears highlightExists when the underlying note is missing', () => {
      // #given — highlight reminder whose note id is not in the cache
      const id = seedReminder({
        targetType: 'highlight',
        targetId: 'note-ghost',
        highlightText: 'orphaned',
        highlightStart: 0,
        highlightEnd: 8
      })

      // #when
      const reminder = remindersService.getReminder(id)

      // #then
      expect(reminder?.targetTitle).toBeNull()
      expect(reminder?.targetExists).toBe(false)
      expect(reminder?.highlightExists).toBe(false)
    })
  })
})
