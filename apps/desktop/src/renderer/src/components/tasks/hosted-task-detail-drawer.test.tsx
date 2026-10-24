import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '@/data/task-model'
import { createDefaultTask } from '@/data/task-model'
import { HostedTaskDetailDrawer } from './hosted-task-detail-drawer'

const mocks = vi.hoisted(() => ({
  deleteTask: vi.fn(),
  updateTask: vi.fn(),
  addTask: vi.fn(),
  tasks: [] as Task[]
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      // oxlint-disable-next-line typescript/no-base-to-string -- test mock; title is always a string in these renders
      values?.title ? `${key}:${String(values.title)}` : key
  })
}))
vi.mock('@/contexts/tasks', () => ({
  useTasksContext: () => ({
    tasks: mocks.tasks,
    projects: [],
    addTask: mocks.addTask,
    updateTask: mocks.updateTask,
    deleteTask: mocks.deleteTask
  })
}))
vi.mock('@/contexts/tabs', () => ({ useTabActions: () => ({ openTab: vi.fn() }) }))
vi.mock('@/hooks/use-task-preferences', () => ({
  useTaskPreferences: () => ({ settings: { nestedSubtasks: true } })
}))
vi.mock('@/hooks/use-undo', () => ({
  useUndoTracker: () => ({ registerUndo: vi.fn(() => 'undo-1'), removeUndoEntry: vi.fn() })
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('./task-detail-drawer', () => ({
  TaskDetailDrawer: ({
    task,
    onDeleteTask,
    onDeleteParentTask
  }: {
    task: Task
    onDeleteTask: (id: string) => void
    onDeleteParentTask: (id: string) => void
  }) => (
    <button
      onClick={() =>
        task.subtaskIds.length > 0 ? onDeleteParentTask(task.id) : onDeleteTask(task.id)
      }
    >
      drawer-delete
    </button>
  )
}))

const build = (id: string, title: string, parentId: string | null, subtaskIds: string[]): Task => ({
  ...createDefaultTask('p1', 's1', title, null, parentId),
  id,
  subtaskIds
})

describe('HostedTaskDetailDrawer delete (#2854)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tasks = [
      build('root', 'Plan launch', null, ['child']),
      build('child', 'Write copy', 'root', ['grandchild']),
      build('grandchild', 'Proofread', 'child', [])
    ]
  })

  it('names the parent and its subtasks before deleting anything', () => {
    render(<HostedTaskDetailDrawer taskId="root" onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('drawer-delete'))

    expect(screen.getByText('subtaskTree.deleteParent.title:Plan launch')).toBeTruthy()
    expect(mocks.deleteTask).not.toHaveBeenCalled()
  })

  it('deletes the branch deepest first when "Delete all" is chosen', () => {
    const onClose = vi.fn()
    render(<HostedTaskDetailDrawer taskId="root" onClose={onClose} />)

    fireEvent.click(screen.getByText('drawer-delete'))
    fireEvent.click(screen.getByText('subtaskTree.deleteParent.deleteAll'))

    expect(mocks.deleteTask.mock.calls.map(([id]) => id)).toEqual(['grandchild', 'child', 'root'])
    expect(onClose).toHaveBeenCalled()
  })

  it('moves direct subtasks up and deletes only the parent when "Keep subtasks" is chosen', () => {
    render(<HostedTaskDetailDrawer taskId="root" onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('drawer-delete'))
    fireEvent.click(screen.getByText('subtaskTree.deleteParent.keepSubtasks'))

    expect(mocks.updateTask).toHaveBeenCalledWith('child', { parentId: null })
    expect(mocks.deleteTask.mock.calls.map(([id]) => id)).toEqual(['root'])
  })
})
