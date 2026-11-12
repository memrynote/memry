import { describe, expect, it } from 'vitest'
import { applyFiltersAndSort } from '@memry/domain-tasks/filtering'
import type { Task } from '@/data/task-model'
import { defaultFilters, defaultSort, type Project, type TaskFilters } from '@/data/tasks-data'
import { appendNodeAt, newRule, seedExpressionFromFilters, updateNodeAt } from './task-filter-rules'

const NOW = new Date(2026, 4, 13, 12, 0)

const task = (id: string, overrides: Partial<Task>): Task => ({
  id,
  title: id,
  description: '',
  projectId: 'p1',
  statusId: 's-todo',
  priority: 'none',
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  repeatFrom: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  parentId: null,
  subtaskIds: [],
  tags: [],
  createdAt: new Date(2026, 0, 1),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

const projects: Project[] = [
  {
    id: 'p1',
    name: 'Work',
    description: '',
    icon: 'folder',
    color: '#000',
    statuses: [
      { id: 's-todo', name: 'To do', color: '#000', type: 'todo', order: 0 },
      { id: 's-doing', name: 'Doing', color: '#000', type: 'in_progress', order: 1 }
    ],
    isDefault: false,
    isArchived: false,
    createdAt: new Date(2026, 0, 1),
    taskCount: 0
  }
]

const tasks: Task[] = [
  task('a', { priority: 'urgent', tags: ['work'], dueDate: new Date(2026, 4, 13) }),
  task('b', { priority: 'high', tags: ['home'], dueDate: new Date(2026, 4, 14) }),
  task('c', { priority: 'urgent', tags: ['work'], statusId: 's-doing', isRepeating: true }),
  task('d', { priority: 'low', tags: [], dueDate: new Date(2026, 4, 20), dueTime: '09:00' }),
  task('e', { priority: 'urgent', projectId: 'p2', tags: ['work'], dueDate: new Date(2026, 4, 15) })
]

const ids = (filters: TaskFilters): string[] =>
  applyFiltersAndSort(tasks, filters, defaultSort, projects, NOW, 1)
    .map((t) => t.id)
    .toSorted()

describe('seedExpressionFromFilters', () => {
  it.each<[string, Partial<TaskFilters>]>([
    ['priority and tags', { priorities: ['urgent'], tags: ['work'] }],
    ['status and project', { statusIds: ['s-doing'], projectIds: ['p1'] }],
    ['due preset', { dueDate: { type: 'this-week', customStart: null, customEnd: null } }],
    [
      'custom due range',
      {
        dueDate: {
          type: 'custom',
          customStart: new Date(2026, 4, 14),
          customEnd: new Date(2026, 4, 15)
        }
      }
    ],
    ['repeat and time', { repeatType: 'one-time', hasTime: 'with-time' }]
  ])('moving %s chips into rules keeps the same tasks', (_, chips) => {
    const filters = { ...defaultFilters, ...chips }
    const { expression, cleared } = seedExpressionFromFilters(filters)

    expect(expression.rules.length).toBeGreaterThan(0)
    expect(ids({ ...filters, ...cleared, expression })).toEqual(ids(filters))
  })

  it('keeps search as a chip, since the search box owns it', () => {
    const { cleared } = seedExpressionFromFilters({ ...defaultFilters, search: 'x' })
    expect(cleared).not.toHaveProperty('search')
  })
})

describe('tree edits', () => {
  it('adds a rule inside a group and removes a node by path', () => {
    let root = appendNodeAt({ match: 'all', rules: [] }, [], newRule('tags'))
    root = appendNodeAt(root, [], { match: 'any', rules: [newRule('priority')] })
    root = appendNodeAt(root, [1], newRule('due'))

    expect(root.rules[1]).toEqual({ match: 'any', rules: [newRule('priority'), newRule('due')] })

    root = updateNodeAt(root, [1, 0], () => null)
    expect(root.rules[1]).toEqual({ match: 'any', rules: [newRule('due')] })
    expect(root.rules[0]).toEqual(newRule('tags'))
  })
})
