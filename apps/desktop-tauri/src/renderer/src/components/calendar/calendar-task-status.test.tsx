import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CalendarTaskStatus } from './calendar-task-status'
import type { Project } from '@/data/tasks-data'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  complete: vi.fn(),
  uncomplete: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn() })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))
vi.mock('@/services/tasks-service', () => ({
  tasksService: { update: mocks.update, complete: mocks.complete, uncomplete: mocks.uncomplete }
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))

const project = {
  id: 'p1',
  statuses: [
    { id: 'todo', name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
    { id: 'doing', name: 'Doing', color: '#3b82f6', type: 'in_progress', order: 1 },
    { id: 'done', name: 'Done', color: '#22c55e', type: 'done', order: 2 }
  ]
} as unknown as Project

vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: () => ({ projects: [project] })
}))

const renderStatus = (statusId: string, isCompleted: boolean): void => {
  render(
    <CalendarTaskStatus taskId="t1" projectId="p1" statusId={statusId} isCompleted={isCompleted} />
  )
}

const pick = async (current: string, next: string): Promise<void> => {
  await userEvent.click(
    screen.getByRole('button', { name: `Status: ${current}. Click to change.` })
  )
  await userEvent.click(await screen.findByText(next))
}

describe('CalendarTaskStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.update.mockResolvedValue({ success: true })
    mocks.complete.mockResolvedValue({ success: true })
    mocks.uncomplete.mockResolvedValue({ success: true })
  })

  it('sets a status that is not done without completing the task', async () => {
    renderStatus('todo', false)
    await pick('To Do', 'Doing')

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ id: 't1', statusId: 'doing' }))
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.uncomplete).not.toHaveBeenCalled()
  })

  it('completes the task, with undo, when a done status is picked', async () => {
    renderStatus('todo', false)
    await pick('To Do', 'Done')

    await waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(1))
    expect(mocks.update).toHaveBeenCalledWith({ id: 't1', statusId: 'done' })
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
    const [, options] = mocks.toast.mock.calls[0] as [string, { action: { onClick: () => void } }]
    options.action.onClick()
    expect(mocks.uncomplete).toHaveBeenCalledWith('t1')
  })

  it('reopens a completed task when another status is picked', async () => {
    renderStatus('done', true)
    await pick('Done', 'Doing')

    await waitFor(() => expect(mocks.uncomplete).toHaveBeenCalledWith('t1'))
    expect(mocks.update).toHaveBeenCalledWith({ id: 't1', statusId: 'doing' })
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('reports a failed change', async () => {
    mocks.update.mockRejectedValueOnce(new Error('offline'))
    renderStatus('todo', false)
    await pick('To Do', 'Doing')

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('offline'))
  })
})
