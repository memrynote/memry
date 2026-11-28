import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useReminderNotifications } from './use-reminder-notifications'

const commands = vi.hoisted(() => ({ reminderGet: vi.fn() }))
type Handler = (event: { payload: unknown }) => void
const handlers = vi.hoisted(() => new Map<string, Handler>())
const events = vi.hoisted(() => {
  const event = (name: string) => ({
    listen: vi.fn((handler: Handler) => {
      handlers.set(name, handler)
      return Promise.resolve(() => {
        if (handlers.get(name) === handler) handlers.delete(name)
      })
    })
  })
  return { reminderDueEvent: event('due'), reminderClickedEvent: event('clicked') }
})
vi.mock('../../../generated/bindings', () => ({ commands, events }))

const toast = vi.hoisted(() => Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/contexts/tabs', () => ({ useTabs: () => ({ openTab: vi.fn() }) }))
vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (key: string) => key }) }))
// A new mutation object on every render, as TanStack's `useMutation` returns.
vi.mock('@/hooks/use-reminders', () => ({ useDismissReminder: () => ({ mutate: vi.fn() }) }))

const view = {
  id: 'rem_1',
  targetType: 'journal',
  targetId: '2026-03-20',
  remindAt: '2026-03-20T09:00:00.000Z',
  anchorId: null,
  highlightText: null,
  highlightStart: null,
  highlightEnd: null,
  title: 'Call back',
  note: null,
  status: 'triggered',
  triggeredAt: '2026-03-20T09:00:01.000Z',
  dismissedAt: null,
  snoozedUntil: null,
  createdAt: '2026-03-20T08:00:00.000Z',
  modifiedAt: '2026-03-20T08:00:00.000Z',
  targetTitle: '2026-03-20',
  targetExists: true,
  highlightExists: null
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
})

describe('useReminderNotifications', () => {
  it('shows the toast of a due reminder whose read-back finishes after a re-render', async () => {
    let answer: (value: typeof view) => void = () => undefined
    commands.reminderGet.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { rerender } = renderHook(() => useReminderNotifications())
    await waitFor(() => expect(handlers.has('due')).toBe(true))

    handlers.get('due')?.({
      payload: {
        reminders: [{ id: 'rem_1', targetType: 'journal', targetId: '2026-03-20' }],
        count: 1
      }
    })
    rerender()
    answer(view)

    await waitFor(() => expect(toast).toHaveBeenCalledWith('Call back', expect.anything()))
  })
})
