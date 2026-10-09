import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { ParentTaskRow } from './parent-task-row'
import { TaskExpansionContext } from '@/components/tasks/subtask-tree/task-expansion-context'
import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

const project: Project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  icon: 'folder',
  color: '#3b82f6',
  statuses: [{ id: 'todo', name: 'To Do', color: '#6b7280', type: 'todo', order: 0 }],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(),
  taskCount: 0
}

const task = (id: string, parentId: string | null, subtaskIds: string[]): Task => ({
  id,
  title: id,
  description: '',
  projectId: 'project-1',
  statusId: 'todo',
  priority: 'medium',
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  repeatFrom: null,
  tags: [],
  linkedNoteIds: [],
  sourceNoteId: null,
  parentId,
  subtaskIds,
  createdAt: new Date(),
  completedAt: null,
  archivedAt: null
})

const tasks = [
  task('parent', null, ['sub1']),
  task('sub1', 'parent', ['sub2']),
  task('sub2', 'sub1', ['sub3']),
  task('sub3', 'sub2', [])
]

/** Inline-start px a class list adds: margins, paddings, and a start border. */
const startPx = (el: Element): number =>
  [...el.classList].reduce((sum, cls) => {
    const arbitrary = /^(?:ms|ps)-\[(\d+)px\]$/.exec(cls)
    if (arbitrary) return sum + Number(arbitrary[1])
    const scale = /^(?:ms|ps|px)-(\d+(?:\.5)?)$/.exec(cls)
    if (scale) return sum + Number(scale[1]) * 4
    return cls === 'border-s' ? sum + 1 : sum
  }, 0)

/** Where a row's chevron starts, from the parent row's outer edge. */
const chevronStart = (row: HTMLElement, root: HTMLElement): number => {
  let offset = 0
  for (let el: HTMLElement | null = row; el && el !== root; el = el.parentElement) {
    offset += startPx(el)
  }
  // The selection column (14px box, 12px gap) precedes a top-level chevron.
  return row.querySelector(':scope > div > [role="checkbox"]') ? offset + 26 : offset
}

const renderTree = (withSelectColumn: boolean): number[] => {
  const { container } = render(
    <TaskExpansionContext.Provider
      value={{ expandedIds: new Set(['sub1', 'sub2']), toggle: vi.fn(), expand: vi.fn() }}
    >
      <ParentTaskRow
        task={tasks[0]}
        project={project}
        allTasks={tasks}
        subtasks={[tasks[1]]}
        progress={{ completed: 0, total: 1, percentage: 0 }}
        isExpanded
        isCompleted={false}
        onToggleExpand={vi.fn()}
        onToggleComplete={vi.fn()}
        onToggleSelect={withSelectColumn ? vi.fn() : undefined}
      />
    </TaskExpansionContext.Provider>
  )
  const root = container.firstElementChild as HTMLElement
  const rows = [
    screen.getByRole('button', { name: /^Task: parent/ }),
    ...screen.getAllByTestId('subtask-row')
  ]
  return rows.map((row) => chevronStart(row, root))
}

describe('ParentTaskRow subtask indent', () => {
  it.each([
    ['with', true],
    ['without', false]
  ])('indents every level right of its parent, %s a selection column', (_, select) => {
    const starts = renderTree(select)
    expect(starts).toHaveLength(4)
    for (let depth = 1; depth < starts.length; depth++) {
      expect(starts[depth]).toBeGreaterThan(starts[depth - 1])
    }
  })
})
