import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddTaskModal } from './add-task-modal'
import type { Project, Status } from '@/data/tasks-data'
import type { Task } from '@/data/sample-tasks'

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

const P_TODO: Status = { id: 'p-todo', name: 'To Do', color: '#666', type: 'todo', order: 0 }
const P_PROGRESS: Status = {
  id: 'p-prog',
  name: 'In Progress',
  color: '#00f',
  type: 'in_progress',
  order: 1
}
const P_DONE: Status = { id: 'p-done', name: 'Done', color: '#0f0', type: 'done', order: 2 }

const W_TODO: Status = { id: 'w-todo', name: 'Backlog', color: '#666', type: 'todo', order: 0 }
const W_PROGRESS: Status = {
  id: 'w-prog',
  name: 'Working',
  color: '#00f',
  type: 'in_progress',
  order: 1
}
const W_DONE: Status = { id: 'w-done', name: 'Shipped', color: '#0f0', type: 'done', order: 2 }

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'personal',
    name: 'Personal',
    description: '',
    icon: 'User',
    color: '#6366f1',
    statuses: [P_TODO, P_PROGRESS, P_DONE],
    isDefault: true,
    isArchived: false,
    createdAt: new Date(),
    taskCount: 0,
    ...overrides
  }
}

const PERSONAL = makeProject()
const WORK = makeProject({
  id: 'work',
  name: 'Work',
  color: '#ef4444',
  isDefault: false,
  statuses: [W_TODO, W_PROGRESS, W_DONE]
})
const PROJECTS = [PERSONAL, WORK]

describe('AddTaskModal', () => {
  let onClose: ReturnType<typeof vi.fn>
  let onAddTask: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onClose = vi.fn()
    onAddTask = vi.fn()
  })

  describe('default project from settings', () => {
    it('submits task with the provided defaultProjectId', async () => {
      // #given — settings set default project to "work"
      const user = userEvent.setup()
      render(
        <AddTaskModal
          isOpen={true}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={PROJECTS}
          defaultProjectId="work"
        />
      )

      // #when — type a title and submit
      const titleInput = screen.getByPlaceholderText('What needs to be done?')
      await user.type(titleInput, 'Test task from settings')
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then — task should be created in the Work project
      expect(onAddTask).toHaveBeenCalledOnce()
      const createdTask: Task = onAddTask.mock.calls[0][0]
      expect(createdTask.projectId).toBe('work')
      expect(createdTask.title).toBe('Test task from settings')
    })

    it('uses work project default todo status when defaultProjectId is work', async () => {
      // #given
      const user = userEvent.setup()
      render(
        <AddTaskModal
          isOpen={true}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={PROJECTS}
          defaultProjectId="work"
        />
      )

      // #when
      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'Status check')
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then — should use Work project's todo status (Backlog), not Personal's
      const createdTask: Task = onAddTask.mock.calls[0][0]
      expect(createdTask.statusId).toBe('w-todo')
    })

    it('falls back to personal when defaultProjectId is omitted', async () => {
      // #given — no defaultProjectId passed (defaults to 'personal')
      const user = userEvent.setup()
      render(
        <AddTaskModal isOpen={true} onClose={onClose} onAddTask={onAddTask} projects={PROJECTS} />
      )

      // #when
      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'Fallback test')
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then
      const createdTask: Task = onAddTask.mock.calls[0][0]
      expect(createdTask.projectId).toBe('personal')
      expect(createdTask.statusId).toBe('p-todo')
    })

    it('handles non-existent defaultProjectId gracefully', async () => {
      // #given — settings point to a deleted project
      const user = userEvent.setup()
      render(
        <AddTaskModal
          isOpen={true}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={PROJECTS}
          defaultProjectId="deleted-project"
        />
      )

      // #when
      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'Ghost project')
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then — should still submit (projectId = deleted-project, empty statusId)
      const createdTask: Task = onAddTask.mock.calls[0][0]
      expect(createdTask.projectId).toBe('deleted-project')
      expect(createdTask.statusId).toBe('')
    })

    it('resets to defaultProjectId when modal reopens', async () => {
      // #given — submit once, close, then reopen
      const user = userEvent.setup()
      const { rerender } = render(
        <AddTaskModal
          isOpen={true}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={PROJECTS}
          defaultProjectId="work"
        />
      )

      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'First task')
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // Reopen the modal
      rerender(
        <AddTaskModal
          isOpen={false}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={PROJECTS}
          defaultProjectId="work"
        />
      )
      rerender(
        <AddTaskModal
          isOpen={true}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={PROJECTS}
          defaultProjectId="work"
        />
      )

      // #when — submit again
      await waitFor(() => {
        expect(screen.getByPlaceholderText('What needs to be done?')).toBeInTheDocument()
      })
      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'Second task')
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then — should still use work project
      const secondTask: Task = onAddTask.mock.calls[1][0]
      expect(secondTask.projectId).toBe('work')
    })
  })

  describe('form validation', () => {
    it('shows error when submitting without title', async () => {
      // #given
      const user = userEvent.setup()
      render(
        <AddTaskModal isOpen={true} onClose={onClose} onAddTask={onAddTask} projects={PROJECTS} />
      )

      // #when — submit without entering title
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then
      expect(screen.getByText('Title is required')).toBeInTheDocument()
      expect(onAddTask).not.toHaveBeenCalled()
    })
  })
})
