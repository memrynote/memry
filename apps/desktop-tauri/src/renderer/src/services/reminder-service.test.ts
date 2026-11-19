import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  reminderService,
  createJournalReminder,
  onReminderClicked,
  onReminderDeleted,
  onReminderDue,
  onReminderSynced,
  onRemindersFired
} from './reminder-service'

const commands = vi.hoisted(() => ({
  reminderCreate: vi.fn(),
  reminderUpdate: vi.fn(),
  reminderDelete: vi.fn(),
  reminderGet: vi.fn(),
  reminderList: vi.fn(),
  reminderGetUpcoming: vi.fn(),
  reminderGetDue: vi.fn(),
  reminderGetForTarget: vi.fn(),
  reminderCountPending: vi.fn(),
  reminderDismiss: vi.fn(),
  reminderSnooze: vi.fn(),
  reminderBulkDismiss: vi.fn()
}))
type Handler = (event: { payload: unknown }) => void
const handlers = vi.hoisted(() => new Map<string, Handler>())
const events = vi.hoisted(() => {
  const event = (name: string) => ({
    listen: vi.fn((handler: Handler) => {
      handlers.set(name, handler)
      return Promise.resolve(() => handlers.delete(name))
    })
  })
  return {
    reminderCreatedEvent: event('created'),
    reminderUpdatedEvent: event('updated'),
    reminderDeletedEvent: event('deleted'),
    reminderDismissedEvent: event('dismissed'),
    reminderSnoozedEvent: event('snoozed'),
    reminderDueEvent: event('due'),
    reminderClickedEvent: event('clicked'),
    syncItemSyncedEvent: event('synced')
  }
})

vi.mock('../../../generated/bindings', () => ({ commands, events }))

const view = {
  id: 'rem_1',
  targetType: 'journal',
  targetId: '2026-03-20',
  remindAt: '2026-03-20T09:00:00.000Z',
  anchorId: null,
  highlightText: null,
  highlightStart: null,
  highlightEnd: null,
  title: null,
  note: null,
  status: 'triggered',
  triggeredAt: '2026-03-20T09:00:01.000Z',
  dismissedAt: null,
  snoozedUntil: null,
  createdAt: '2026-03-20T08:00:00.000Z',
  modifiedAt: '2026-03-20T08:00:00.000Z'
}
const withTarget = { ...view, targetTitle: '2026-03-20', targetExists: true, highlightExists: null }
const hint = { id: 'rem_1', targetType: 'journal', targetId: '2026-03-20' }

/** Lets the event's read-back settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  for (const command of Object.values(commands)) command.mockReset()
  handlers.clear()
})

describe('reminder-service', () => {
  it('answers a write with the reminder, as Electron does', async () => {
    commands.reminderCreate.mockResolvedValue(view)

    const created = await createJournalReminder('2026-03-20', '2026-03-20T09:00:00.000Z')

    expect(commands.reminderCreate).toHaveBeenCalledWith({
      targetType: 'journal',
      targetId: '2026-03-20',
      remindAt: '2026-03-20T09:00:00.000Z',
      title: undefined,
      note: undefined
    })
    expect(created).toEqual({ success: true, reminder: view })
  })

  it('answers a refused write with its message, as Electron withErrorHandler does', async () => {
    const notFound = { kind: 'notFound', code: 'reminder_not_found', message: 'Reminder not found' }
    commands.reminderDismiss.mockRejectedValue(notFound)
    commands.reminderDelete.mockRejectedValue(notFound)
    commands.reminderBulkDismiss.mockRejectedValue(notFound)

    expect(await reminderService.dismiss('rem_x')).toEqual({
      success: false,
      reminder: null,
      error: 'Reminder not found'
    })
    expect(await reminderService.delete('rem_x')).toEqual({
      success: false,
      error: 'Reminder not found'
    })
    expect(await reminderService.bulkDismiss(['rem_x'])).toEqual({
      success: false,
      dismissedCount: 0,
      error: 'Reminder not found'
    })
  })

  it('maps delete, bulk dismiss and the reads to Electron shapes', async () => {
    commands.reminderDelete.mockResolvedValue(null)
    commands.reminderBulkDismiss.mockResolvedValue(2)
    commands.reminderGet.mockResolvedValue(withTarget)
    commands.reminderList.mockResolvedValue({ reminders: [withTarget], total: 1, hasMore: false })
    commands.reminderGetForTarget.mockResolvedValue([view])

    expect(await reminderService.delete('rem_1')).toEqual({ success: true })
    expect(await reminderService.bulkDismiss(['rem_1', 'rem_2'])).toEqual({
      success: true,
      dismissedCount: 2
    })
    expect(commands.reminderBulkDismiss).toHaveBeenCalledWith(['rem_1', 'rem_2'])
    expect(await reminderService.get('rem_1')).toEqual({
      ...withTarget,
      highlightExists: undefined
    })

    const listed = await reminderService.list({ status: 'triggered' })
    expect(commands.reminderList).toHaveBeenCalledWith({ status: 'triggered' })
    expect(listed.reminders[0]?.status).toBe('triggered')
    await reminderService.list()
    expect(commands.reminderList).toHaveBeenLastCalledWith(null)

    expect(await reminderService.getForTarget('journal', '2026-03-20')).toEqual([view])
    expect(commands.reminderGetForTarget).toHaveBeenCalledWith({
      targetType: 'journal',
      targetId: '2026-03-20'
    })
  })

  it('answers a due event with the fired reminders read back, and the count it fired', async () => {
    commands.reminderGet.mockImplementation((id: string) =>
      Promise.resolve(id === 'rem_1' ? withTarget : null)
    )
    const callback = vi.fn()
    onReminderDue(callback)

    handlers.get('due')?.({ payload: { reminders: [hint, { ...hint, id: 'rem_gone' }], count: 2 } })
    await settle()

    expect(callback).toHaveBeenCalledWith({
      reminders: [{ ...withTarget, highlightExists: undefined }],
      count: 2
    })
  })

  it('passes fired reminders as the due event names them, with no read-back', () => {
    const callback = vi.fn()
    onRemindersFired(callback)

    handlers.get('due')?.({ payload: { reminders: [hint], count: 1 } })

    expect(callback).toHaveBeenCalledWith([hint])
    expect(commands.reminderGet).not.toHaveBeenCalled()
  })

  it('names a reminder a pull applied, and ignores pushes and other types', () => {
    const callback = vi.fn()
    onReminderSynced(callback)
    const synced = (payload: {
      itemId: string
      type: string
      operation: string
      itemOperation?: string
    }): void => handlers.get('synced')?.({ payload })

    synced({ itemId: 'rem_1', type: 'reminder', operation: 'push' })
    synced({ itemId: 'task_1', type: 'task', operation: 'pull' })
    synced({ itemId: 'rem_1', type: 'reminder', operation: 'pull', itemOperation: 'update' })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ id: 'rem_1' })
  })

  it('answers a notification click with the reminder, and nothing once unsubscribed', async () => {
    commands.reminderGet.mockResolvedValue(withTarget)
    const callback = vi.fn()
    const unsubscribe = onReminderClicked(callback)

    handlers.get('clicked')?.({ payload: { reminder: hint } })
    unsubscribe()
    await settle()

    expect(callback).not.toHaveBeenCalled()
  })

  it('passes a command event to its subscriber with the reminder target', () => {
    const callback = vi.fn()
    onReminderDeleted(callback)

    handlers.get('deleted')?.({ payload: { reminder: hint } })

    expect(callback).toHaveBeenCalledWith({ reminder: hint })
  })
})
