import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { canHaveSubtasks } from '@/lib/subtask-utils'
import { SubtaskTreeContext, type SubtaskTreeValue } from './subtask-tree-context'
import { ZoomedBranchView } from './zoomed-branch-view'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/components/tasks/sortable-subtask-list', () => ({
  SortableSubtaskList: () => null
}))

const project: Project = {
  id: 'p',
  name: 'Project',
  color: '#6366F1',
  statuses: [{ id: 'todo', name: 'To Do', color: '#6B7280', type: 'todo', order: 0 }],
  isArchived: false,
  description: '',
  icon: 'folder',
  isDefault: false,
  createdAt: new Date(2026, 0, 1),
  taskCount: 0
}

const task = (id: string, parentId: string | null, subtaskIds: string[] = []): Task => ({
  id,
  title: id,
  description: '',
  projectId: 'p',
  statusId: 'todo',
  priority: 'none',
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  repeatFrom: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  tags: [],
  parentId,
  subtaskIds,
  createdAt: new Date(2026, 0, 1),
  completedAt: null,
  archivedAt: null
})

// A deeper tree synced from a device with nested subtasks on, viewed here with it off.
const tasks = [task('root', null, ['mid']), task('mid', 'root', ['leaf']), task('leaf', 'mid')]

const renderZoomed = (zoomedId: string, allowNested: boolean): void => {
  const tree = {
    allowNested,
    draftParentId: null,
    canAddUnder: (id: string) =>
      canHaveSubtasks(
        tasks.find((t) => t.id === id)!,
        allowNested
      ),
    openDraft: vi.fn()
  } as unknown as SubtaskTreeValue
  render(
    <SubtaskTreeContext.Provider value={tree}>
      <ZoomedBranchView
        task={tasks.find((t) => t.id === zoomedId)!}
        tasks={tasks}
        project={project}
        onZoom={vi.fn()}
        onToggleComplete={vi.fn()}
        onToggleSubtaskComplete={vi.fn()}
        onReorderSubtasks={vi.fn()}
        onTaskClick={vi.fn()}
      />
    </SubtaskTreeContext.Provider>
  )
}

describe('ZoomedBranchView add subtask', () => {
  it('does not offer adding under a subtask when nested subtasks are off', () => {
    renderZoomed('mid', false)
    expect(screen.queryByRole('button', { name: 'subtaskTree.addSubtask' })).toBeNull()
  })

  it('offers adding under a subtask when nested subtasks are on', () => {
    renderZoomed('mid', true)
    expect(screen.getByRole('button', { name: 'subtaskTree.addSubtask' })).toBeTruthy()
  })
})
