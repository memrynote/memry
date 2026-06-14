import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ReminderDetail } from './reminder-detail'

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  markViewed: vi.fn(() => Promise.resolve()),
  archive: vi.fn(() => Promise.resolve({ success: true })),
  toastSuccess: vi.fn(),
  invalidateQueries: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, info: vi.fn() }
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab: mocks.openTab })
}))

vi.mock('@/services/inbox-service', () => ({
  inboxService: {
    markViewed: mocks.markViewed,
    snooze: vi.fn(() => Promise.resolve()),
    archive: mocks.archive,
    undoArchive: vi.fn(() => Promise.resolve({ success: true }))
  }
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries })
}))

vi.mock('@/hooks/use-inbox', () => ({
  inboxKeys: { lists: () => ['inbox', 'lists'], stats: () => ['inbox', 'stats'] }
}))

vi.mock('@/components/snooze/snooze-picker', () => ({
  SnoozePicker: () => null
}))

vi.mock('@/components/snooze/snooze-presets', () => ({
  inOneHour: () => new Date('2026-05-10T01:00:00.000Z'),
  tomorrow: () => new Date('2026-05-11T09:00:00.000Z'),
  nextWeek: () => new Date('2026-05-17T09:00:00.000Z')
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), debug: vi.fn() })
}))

const taskItem = {
  id: 'inbox_rem_1',
  type: 'reminder' as const,
  title: 'Ship release',
  content: null,
  viewedAt: null,
  metadata: {
    reminderId: 'rem-1',
    targetType: 'task' as const,
    targetId: 'task-9',
    targetTitle: 'Ship release',
    projectId: 'proj-2',
    remindAt: '2026-05-10T09:00:00.000Z'
  }
}

describe('ReminderDetail task navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens the Tasks tab with the task drawer when a task reminder source is clicked', () => {
    render(<ReminderDetail item={taskItem as never} />)

    fireEvent.click(screen.getByText('Ship release').closest('button') as HTMLButtonElement)

    expect(mocks.markViewed).toHaveBeenCalledWith('inbox_rem_1')
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tasks',
        path: '/tasks',
        viewState: expect.objectContaining({
          openTaskId: 'task-9',
          selectedProjectId: 'proj-2'
        })
      })
    )
  })

  it('renders a real middot separator, not a literal "&middot;" entity', () => {
    const { container } = render(<ReminderDetail item={taskItem as never} />)

    expect(container.textContent).toContain('·')
    expect(container.textContent).not.toContain('middot')
  })

  it('archives the reminder and toasts "Archived" when the Archive button is clicked', async () => {
    render(<ReminderDetail item={taskItem as never} />)

    fireEvent.click(screen.getByRole('button', { name: 'reminder.archive' }))

    await waitFor(() => expect(mocks.archive).toHaveBeenCalledWith('inbox_rem_1'))
    expect(mocks.markViewed).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('Archived'),
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
    )
  })
})
