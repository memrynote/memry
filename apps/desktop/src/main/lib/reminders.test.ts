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
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
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

const { enqueueCreateSpy, enqueueUpdateSpy, enqueueDeleteSpy } = vi.hoisted(() => ({
  enqueueCreateSpy: vi.fn(),
  enqueueUpdateSpy: vi.fn(),
  enqueueDeleteSpy: vi.fn()
}))

vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: enqueueCreateSpy,
  enqueueLocalSyncUpdate: enqueueUpdateSpy,
  enqueueLocalSyncDelete: enqueueDeleteSpy
}))

const notificationInstances: MockNotification[] = []
const getStatusMock = vi.fn(() => ({
  isOpen: true,
  path: '/test-vault',
  isIndexing: false,
  indexProgress: 0,
  error: null
}))
const loggerMock = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}
const setBadgeCountMock = vi.fn()

const realPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const setPlatform = (value: string): void => {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

type MockNotificationOptions = {
  id?: string
  groupId?: string
  title: string
  body: string
  silent?: boolean
}

class MockNotification {
  static isSupported = vi.fn(() => true)
  // Electron 42+ API; set to undefined in tests to simulate older Electron.
  static remove: ReturnType<typeof vi.fn> | undefined = vi.fn()
  options: MockNotificationOptions
  handlers: Record<string, (...args: unknown[]) => void> = {}
  show = vi.fn()
  close = vi.fn()

  constructor(options: MockNotificationOptions) {
    this.options = options
    notificationInstances.push(this)
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers[event] = handler
    return this
  }

  once(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers[event] = handler
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    this.handlers[event]?.(...args)
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

  const seedTask = (id: string, title: string, projectId: string): void => {
    const now = '2025-01-01T00:00:00.000Z'
    dataDb.db
      .insert(projects)
      .values({ id: projectId, name: projectId, createdAt: now, modifiedAt: now })
      .onConflictDoNothing()
      .run()
    dataDb.db.insert(tasks).values({ id, projectId, title, createdAt: now, modifiedAt: now }).run()
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
    MockNotification.remove = vi.fn()
    setBadgeCountMock.mockReset()
    reminderCounter = 0
    emitCalendarProjectionChanged.mockClear()
    scheduleGoogleCalendarSourceSync.mockClear()
    enqueueCreateSpy.mockClear()
    enqueueUpdateSpy.mockClear()
    enqueueDeleteSpy.mockClear()
    getStatusMock.mockReset()
    getStatusMock.mockReturnValue({
      isOpen: true,
      path: '/test-vault',
      isIndexing: false,
      indexProgress: 0,
      error: null
    })

    vi.resetModules()
    vi.doMock('electron', () => ({
      app: {
        setBadgeCount: setBadgeCountMock
      },
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
      getStatus: getStatusMock
    }))
    vi.doMock('./logger', () => ({
      createLogger: () => loggerMock
    }))
    vi.doMock('./main-i18n', () => {
      const systemTranslations: Record<string, string> = {
        'notification.reminder.note': 'Note reminder',
        'notification.reminder.journal': 'Journal reminder',
        'notification.reminder.highlight': 'Highlight reminder',
        'notification.reminder.task': 'Task reminder',
        'notification.reminder.fallback': 'Reminder due',
        'notification.reminder.default': 'Reminder',
        'error.reminderTimeMustBeFuture': 'Reminder time must be in the future'
      }
      return {
        getMainI18n: () => ({
          t: (key: string) =>
            key.startsWith('system:')
              ? (systemTranslations[key.slice('system:'.length)] ?? key)
              : key,
          getFixedT: (_lng: unknown, _ns: string) => (key: string) => systemTranslations[key] ?? key
        })
      }
    })

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
    Object.defineProperty(process, 'platform', realPlatformDescriptor)
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

  it('routes a notification click past a destroyed window to the first live one', () => {
    seedNoteCache('note-1', 'Focus Note')
    seedReminder({
      id: 'rem-destroyed',
      targetType: 'note',
      targetId: 'note-1',
      remindAt: '2000-01-01T00:00:00.000Z',
      status: reminderStatus.PENDING
    })

    // getAllWindows() can still list a destroyed short-lived window (splash,
    // quick capture, print/export). Real Electron throws 'Object has been
    // destroyed' on any access to one, so taking windows[0] blindly kills the
    // click handler and focuses nothing.
    const destroyed = {
      isDestroyed: () => true,
      isMinimized(): never {
        throw new Error('Object has been destroyed')
      },
      focus(): never {
        throw new Error('Object has been destroyed')
      },
      get webContents(): never {
        throw new Error('Object has been destroyed')
      }
    }
    remindersService.startReminderScheduler()
    remindersService.stopReminderScheduler()

    const notification = notificationInstances[0]
    expect(notification).toBeDefined()

    // The window dies between the banner being shown and the user clicking it.
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      destroyed as unknown as import('electron').BrowserWindow,
      window as unknown as import('electron').BrowserWindow
    ])

    expect(() => notification?.emit('click')).not.toThrow()
    expect(window.focus).toHaveBeenCalled()
    expect(window.webContents.send).toHaveBeenCalledWith(
      ReminderChannels.events.CLICKED,
      expect.objectContaining({
        reminder: expect.objectContaining({ id: 'rem-destroyed' })
      })
    )
  })

  it('builds notifications with a stable id/groupId and logs delivery failures without throwing', () => {
    seedNoteCache('note-1', 'Focus Note')
    seedReminder({
      id: 'rem-failed',
      targetType: 'note',
      targetId: 'note-1',
      remindAt: '2000-01-01T00:00:00.000Z',
      status: reminderStatus.PENDING
    })

    remindersService.startReminderScheduler()
    remindersService.stopReminderScheduler()

    expect(notificationInstances).toHaveLength(1)
    const notification = notificationInstances[0]
    // Electron 42+: stable per-reminder id + shared groupId for banner grouping.
    expect(notification?.options.id).toBe('rem-failed')
    expect(notification?.options.groupId).toBe('memry-reminders')

    // A 'failed' delivery (e.g. unsigned macOS build) is logged, not rethrown.
    const deliveryError = new Error('notification delivery failed')
    expect(() => notification?.emit('failed', {}, deliveryError)).not.toThrow()
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Desktop notification failed for reminder rem-failed:',
      deliveryError
    )
  })

  it('lands a task reminder in the inbox with task title, projectId, and notification', () => {
    seedTask('task-due', 'Ship release', 'proj-9')
    seedReminder({
      id: 'rem-task-due',
      targetType: 'task',
      targetId: 'task-due',
      remindAt: '2000-01-01T00:00:00.000Z',
      status: reminderStatus.PENDING
    })

    remindersService.startReminderScheduler()
    remindersService.stopReminderScheduler()

    expect(notificationInstances).toHaveLength(1)
    expect(notificationInstances[0]?.options.title).toContain('Ship release')
    expect(notificationInstances[0]?.options.body).toBe('Task reminder')

    const inboxRow = dataDb.db
      .select()
      .from(inboxItems)
      .all()
      .find((item) => item.type === 'reminder')

    expect(inboxRow?.title).toBe('Ship release')
    expect(inboxRow?.metadata).toEqual(
      expect.objectContaining({
        reminderId: 'rem-task-due',
        targetType: 'task',
        targetId: 'task-due',
        targetTitle: 'Ship release',
        projectId: 'proj-9'
      })
    )
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

  describe('delivered notification cleanup (Electron 42+, macOS)', () => {
    it('removes the delivered notification banner on dismiss', () => {
      setPlatform('darwin')
      seedReminder({ id: 'rem-nc1', status: reminderStatus.TRIGGERED })

      const result = remindersService.dismissReminder('rem-nc1')

      expect(result?.status).toBe(reminderStatus.DISMISSED)
      expect(MockNotification.remove).toHaveBeenCalledWith('rem-nc1')
    })

    it('removes the delivered notification banner on snooze', () => {
      setPlatform('darwin')
      seedReminder({ id: 'rem-nc2', status: reminderStatus.TRIGGERED })

      const snoozeUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      const result = remindersService.snoozeReminder({ id: 'rem-nc2', snoozeUntil })

      expect(result?.status).toBe(reminderStatus.SNOOZED)
      expect(MockNotification.remove).toHaveBeenCalledWith('rem-nc2')
    })

    it('does not touch delivered notifications on non-darwin platforms', () => {
      setPlatform('win32')
      seedReminder({ id: 'rem-nc3', status: reminderStatus.TRIGGERED })
      seedReminder({ id: 'rem-nc4', status: reminderStatus.TRIGGERED })

      remindersService.dismissReminder('rem-nc3')
      remindersService.snoozeReminder({
        id: 'rem-nc4',
        snoozeUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      })

      expect(MockNotification.remove).not.toHaveBeenCalled()
    })

    it('is a silent no-op when Notification.remove is unavailable (Electron <42)', () => {
      setPlatform('darwin')
      MockNotification.remove = undefined
      seedReminder({ id: 'rem-nc5', status: reminderStatus.TRIGGERED })

      const result = remindersService.dismissReminder('rem-nc5')

      expect(result?.status).toBe(reminderStatus.DISMISSED)
    })

    it('logs and keeps dismissing when Notification.remove throws', () => {
      setPlatform('darwin')
      const removeError = new Error('notification center unavailable')
      MockNotification.remove?.mockImplementation(() => {
        throw removeError
      })
      seedReminder({ id: 'rem-nc6', status: reminderStatus.TRIGGERED })

      const result = remindersService.dismissReminder('rem-nc6')

      expect(result?.status).toBe(reminderStatus.DISMISSED)
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Failed to remove delivered notification for reminder rem-nc6:',
        removeError
      )
    })
  })

  describe('dock badge count', () => {
    it('sets the badge from the pending count when the scheduler starts', () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      seedReminder({ id: 'rem-bg1', remindAt: future, status: reminderStatus.PENDING })
      seedReminder({
        id: 'rem-bg2',
        remindAt: future,
        status: reminderStatus.SNOOZED,
        snoozedUntil: future
      })

      remindersService.startReminderScheduler()
      remindersService.stopReminderScheduler()

      expect(setBadgeCountMock).toHaveBeenLastCalledWith(2)
    })

    it('drops the badge count when a due reminder fires', () => {
      seedReminder({
        id: 'rem-bg3',
        remindAt: '2000-01-01T00:00:00.000Z',
        status: reminderStatus.PENDING
      })
      seedReminder({
        id: 'rem-bg4',
        remindAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        status: reminderStatus.PENDING
      })

      remindersService.startReminderScheduler()
      remindersService.stopReminderScheduler()

      expect(setBadgeCountMock).toHaveBeenLastCalledWith(1)
    })

    it('clears the badge when the last pending reminder is dismissed', () => {
      seedReminder({ id: 'rem-bg5', status: reminderStatus.PENDING })

      remindersService.dismissReminder('rem-bg5')

      expect(setBadgeCountMock).toHaveBeenLastCalledWith(0)
    })

    it('counts a snoozed reminder back into the badge', () => {
      seedReminder({ id: 'rem-bg6', status: reminderStatus.TRIGGERED })

      remindersService.snoozeReminder({
        id: 'rem-bg6',
        snoozeUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      })

      expect(setBadgeCountMock).toHaveBeenLastCalledWith(1)
    })

    it('updates the badge on create and delete', () => {
      const created = remindersService.createReminder({
        targetType: 'note',
        targetId: 'note-1',
        remindAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      })
      expect(setBadgeCountMock).toHaveBeenLastCalledWith(1)

      remindersService.deleteReminder(created.id)
      expect(setBadgeCountMock).toHaveBeenLastCalledWith(0)
    })

    it('updates the badge after bulk dismiss', () => {
      seedReminder({ id: 'rem-bg7', status: reminderStatus.PENDING })
      seedReminder({ id: 'rem-bg8', status: reminderStatus.PENDING })

      remindersService.bulkDismissReminders(['rem-bg7', 'rem-bg8'])

      expect(setBadgeCountMock).toHaveBeenLastCalledWith(0)
    })

    it('swallows and logs badge failures without breaking the reminder flow', () => {
      const badgeError = new Error('badge unsupported')
      setBadgeCountMock.mockImplementation(() => {
        throw badgeError
      })
      seedReminder({ id: 'rem-bg9', status: reminderStatus.PENDING })

      const result = remindersService.dismissReminder('rem-bg9')

      expect(result?.status).toBe(reminderStatus.DISMISSED)
      expect(loggerMock.warn).toHaveBeenCalledWith('Failed to update app badge count:', badgeError)
    })
  })

  it('validates reminder mutations, missing rows, and pending count fallbacks', () => {
    const pastDate = '2000-01-01T00:00:00.000Z'
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const laterFutureDate = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()

    expect(() =>
      remindersService.createReminder({
        targetType: 'note',
        targetId: 'note-1',
        remindAt: pastDate
      })
    ).toThrow('Reminder time must be in the future')

    const created = remindersService.createReminder({
      targetType: 'highlight',
      targetId: 'note-1',
      remindAt: futureDate,
      highlightText: 'important passage',
      highlightStart: 4,
      highlightEnd: 21
    })
    expect(created.highlightText).toBe('important passage')
    expect(created.highlightStart).toBe(4)

    expect(() => remindersService.updateReminder({ id: created.id, remindAt: pastDate })).toThrow(
      'Reminder time must be in the future'
    )

    const rescheduled = remindersService.updateReminder({
      id: created.id,
      remindAt: laterFutureDate,
      title: 'Later',
      note: 'Bring context'
    })
    expect(rescheduled).toEqual(
      expect.objectContaining({
        status: reminderStatus.PENDING,
        remindAt: laterFutureDate,
        title: 'Later',
        note: 'Bring context',
        triggeredAt: null,
        snoozedUntil: null
      })
    )

    expect(remindersService.updateReminder({ id: 'missing', title: 'No row' })).toBeNull()
    expect(remindersService.deleteReminder('missing')).toBe(false)
    expect(remindersService.dismissReminder('missing')).toBeNull()
    expect(() =>
      remindersService.snoozeReminder({ id: created.id, snoozeUntil: pastDate })
    ).toThrow('Snooze time must be in the future')
    expect(
      remindersService.snoozeReminder({ id: 'missing', snoozeUntil: laterFutureDate })
    ).toBeNull()

    seedReminder({ id: 'rem-count-snoozed', status: reminderStatus.SNOOZED })
    seedReminder({ id: 'rem-count-dismissed', status: reminderStatus.DISMISSED })
    expect(remindersService.countPendingReminders()).toBe(2)

    vi.mocked(getDatabase).mockImplementationOnce(() => {
      throw new Error('db offline')
    })
    expect(remindersService.countPendingReminders()).toBe(0)
  })

  it('skips scheduler processing when the vault is closed or no reminders are due', () => {
    getStatusMock.mockReturnValueOnce({
      isOpen: false,
      path: '/test-vault',
      isIndexing: false,
      indexProgress: 0,
      error: null
    })

    remindersService.startReminderScheduler()
    remindersService.stopReminderScheduler()
    expect(notificationInstances).toEqual([])

    seedReminder({
      id: 'future-reminder',
      remindAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: reminderStatus.PENDING
    })

    remindersService.startReminderScheduler()
    remindersService.stopReminderScheduler()
    expect(notificationInstances).toEqual([])
  })

  it('uses fallback notification labels for due journal reminders', () => {
    seedReminder({
      id: 'journal-due',
      targetType: 'journal',
      targetId: '2026-05-10',
      remindAt: '2000-01-01T00:00:00.000Z',
      status: reminderStatus.PENDING
    })

    remindersService.startReminderScheduler()
    remindersService.stopReminderScheduler()

    expect(notificationInstances).toHaveLength(1)
    expect(notificationInstances[0]?.options.title).toContain('2026-05-10')
    expect(notificationInstances[0]?.options.body).toBe('Journal reminder')

    const inboxRow = dataDb.db.select().from(inboxItems).all()[0]
    expect(inboxRow?.metadata).toEqual(
      expect.objectContaining({
        reminderId: 'journal-due',
        targetType: 'journal',
        targetId: '2026-05-10',
        targetTitle: '2026-05-10'
      })
    )
  })

  it('still creates inbox reminder items when desktop notifications are unsupported', () => {
    MockNotification.isSupported.mockReturnValue(false)
    const highlightText = 'a'.repeat(120)
    seedReminder({
      id: 'highlight-due',
      targetType: 'highlight',
      targetId: 'note-highlight',
      remindAt: '2000-01-01T00:00:00.000Z',
      highlightText,
      highlightStart: 2,
      highlightEnd: 122,
      status: reminderStatus.PENDING
    })

    remindersService.startReminderScheduler()
    remindersService.stopReminderScheduler()

    expect(notificationInstances).toEqual([])
    const inboxRow = dataDb.db.select().from(inboxItems).all()[0]
    expect(inboxRow?.content).toBe(highlightText)
    expect(inboxRow?.metadata).toEqual(
      expect.objectContaining({
        reminderId: 'highlight-due',
        targetType: 'highlight',
        highlightText,
        highlightStart: 2,
        highlightEnd: 122
      })
    )
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

    it('resolves task title and projectId for task reminders', () => {
      // #given
      seedTask('task-7', 'Ship release', 'proj-1')
      const id = seedReminder({ targetType: 'task', targetId: 'task-7' })

      // #when
      const reminder = remindersService.getReminder(id)

      // #then
      expect(reminder?.targetTitle).toBe('Ship release')
      expect(reminder?.targetExists).toBe(true)
      expect(reminder?.projectId).toBe('proj-1')
      expect(reminder?.highlightExists).toBeUndefined()
    })

    it('marks task reminders missing from the data db as non-existent', () => {
      // #given — no seedTask for this id
      const id = seedReminder({ targetType: 'task', targetId: 'task-gone' })

      // #when
      const reminder = remindersService.getReminder(id)

      // #then
      expect(reminder?.targetTitle).toBeNull()
      expect(reminder?.targetExists).toBe(false)
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

  describe('reminder sync enqueue', () => {
    it('enqueues a create when a reminder is created', () => {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      const created = remindersService.createReminder({
        targetType: 'note',
        targetId: 'note-1',
        remindAt: futureDate
      })

      expect(enqueueCreateSpy).toHaveBeenCalledWith('reminder', created.id)
    })

    it('enqueues an update when a reminder is updated', () => {
      const id = seedReminder({ remindAt: '2025-01-20T09:00:00.000Z' })
      enqueueUpdateSpy.mockClear()

      remindersService.updateReminder({ id, title: 'Updated title' })

      expect(enqueueUpdateSpy).toHaveBeenCalledWith('reminder', id)
    })

    it('enqueues an update when a reminder is dismissed', () => {
      const id = seedReminder({ status: reminderStatus.PENDING })
      enqueueUpdateSpy.mockClear()

      remindersService.dismissReminder(id)

      expect(enqueueUpdateSpy).toHaveBeenCalledWith('reminder', id)
    })

    it('enqueues an update when a reminder is snoozed', () => {
      const id = seedReminder({ status: reminderStatus.PENDING })
      enqueueUpdateSpy.mockClear()

      const snoozeUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      remindersService.snoozeReminder({ id, snoozeUntil })

      expect(enqueueUpdateSpy).toHaveBeenCalledWith('reminder', id)
    })

    it('enqueues an update per dismissed reminder on bulk dismiss', () => {
      const idA = seedReminder({ status: reminderStatus.PENDING })
      const idB = seedReminder({ status: reminderStatus.PENDING })
      enqueueUpdateSpy.mockClear()

      remindersService.bulkDismissReminders([idA, idB, 'missing'])

      expect(enqueueUpdateSpy).toHaveBeenCalledWith('reminder', idA)
      expect(enqueueUpdateSpy).toHaveBeenCalledWith('reminder', idB)
      expect(enqueueUpdateSpy).not.toHaveBeenCalledWith('reminder', 'missing')
    })

    it('does NOT enqueue when the scheduler marks a reminder triggered', () => {
      seedReminder({
        id: 'rem-trigger-enqueue',
        remindAt: '2000-01-01T00:00:00.000Z',
        status: reminderStatus.PENDING
      })
      enqueueUpdateSpy.mockClear()
      enqueueCreateSpy.mockClear()

      remindersService.startReminderScheduler()
      remindersService.stopReminderScheduler()

      const updated = dataDb.db
        .select()
        .from(reminders)
        .where(eq(reminders.id, 'rem-trigger-enqueue'))
        .get()
      expect(updated?.status).toBe(reminderStatus.TRIGGERED)
      expect(enqueueUpdateSpy).not.toHaveBeenCalled()
      expect(enqueueCreateSpy).not.toHaveBeenCalled()
    })

    it('enqueues a delete with a snapshot that omits triggeredAt', () => {
      const id = seedReminder({ status: reminderStatus.TRIGGERED })
      dataDb.db
        .update(reminders)
        .set({ triggeredAt: '2025-01-01T00:05:00.000Z', clock: { 'device-a': 3 } })
        .where(eq(reminders.id, id))
        .run()

      remindersService.deleteReminder(id)

      expect(enqueueDeleteSpy).toHaveBeenCalledWith('reminder', id, expect.any(String))
      const snapshot = JSON.parse(enqueueDeleteSpy.mock.calls[0]?.[2] as string) as Record<
        string,
        unknown
      >
      // Real fields must survive the destructure — a regression that
      // replaced it with e.g. `JSON.stringify({ id })` would still pass the
      // `id`/`triggeredAt`-absence checks below but lose everything else.
      expect(snapshot.id).toBe(id)
      expect(snapshot.status).toBe(reminderStatus.TRIGGERED)
      expect(snapshot.clock).toEqual({ 'device-a': 3 })
      expect('triggeredAt' in snapshot).toBe(false)
    })
  })
})

describe('reminder notification labels (i18n)', () => {
  it('English: note reminder body label', async () => {
    const { createMainI18n } = await import('@memry/i18n/main')
    const i18n = await createMainI18n({ locale: 'en' })
    expect(i18n.t('system:notification.reminder.note')).toBe('Note reminder')
    expect(i18n.t('system:notification.reminder.journal')).toBe('Journal reminder')
    expect(i18n.t('system:notification.reminder.highlight')).toBe('Highlight reminder')
    expect(i18n.t('system:notification.reminder.fallback')).toBe('Reminder due')
    expect(i18n.t('system:notification.reminder.default')).toBe('Reminder')
  })

  it('English: reminder validation error', async () => {
    const { createMainI18n } = await import('@memry/i18n/main')
    const i18n = await createMainI18n({ locale: 'en' })
    expect(i18n.t('system:error.reminderTimeMustBeFuture')).toBe(
      'Reminder time must be in the future'
    )
  })

  it('Turkish: note reminder body label', async () => {
    const { createMainI18n } = await import('@memry/i18n/main')
    const i18n = await createMainI18n({ locale: 'tr' })
    expect(i18n.t('system:notification.reminder.note')).toBe('Not hatırlatıcısı')
  })
})
