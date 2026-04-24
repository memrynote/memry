import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

type TaskStatus = 'todo' | 'in-progress' | 'done' | 'canceled'
type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'

interface MockTask {
  id: string
  title: string
  status: TaskStatus
  priority: TaskPriority
  projectId: string | null
  dueAt: number | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  tags: string[]
  noteId: string | null
}

const statuses: TaskStatus[] = ['todo', 'in-progress', 'done', 'canceled']
const priorities: TaskPriority[] = ['low', 'medium', 'high', 'urgent']

const turkishTitles = [
  'Haftalık rapor hazırla',
  'Müşteri çağrısına katıl',
  'Özgürlük için proje güncellemesi'
]

const tasks: MockTask[] = Array.from({ length: 15 }, (_, i) => {
  const status = statuses[i % 4]
  const priority = priorities[i % 4]
  const title =
    i < turkishTitles.length ? turkishTitles[i]! : `Mock task #${i + 1}`
  return {
    id: `task-${i + 1}`,
    title,
    status,
    priority,
    projectId: i < 10 ? 'project-1' : 'project-2',
    dueAt: i < 8 ? mockTimestamp(-1 * (i - 4)) : null,
    createdAt: mockTimestamp(10 - i),
    updatedAt: mockTimestamp(i < 5 ? 0 : 1),
    completedAt: status === 'done' ? mockTimestamp(0) : null,
    tags: i % 3 === 0 ? ['mock', 'm1'] : [],
    noteId: null
  }
})

export const tasksRoutes: MockRouteMap = {
  tasks_list: async () => tasks,
  tasks_list_by_project: async (args) => {
    const { projectId } = args as { projectId: string }
    return tasks.filter((t) => t.projectId === projectId)
  },
  tasks_get: async (args) => {
    const { id } = args as { id: string }
    const t = tasks.find((x) => x.id === id)
    if (!t) throw new Error(`Task ${id} not found`)
    return t
  },
  tasks_create: async (args) => {
    const input = (args as Partial<MockTask>) ?? {}
    const now = Date.now()
    const task: MockTask = {
      id: mockId('task'),
      title: input.title ?? 'New task',
      status: input.status ?? 'todo',
      priority: input.priority ?? 'medium',
      projectId: input.projectId ?? null,
      dueAt: input.dueAt ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      tags: input.tags ?? [],
      noteId: input.noteId ?? null
    }
    tasks.unshift(task)
    return task
  },
  tasks_update: async (args) => {
    const { id, ...changes } = args as { id: string } & Partial<MockTask>
    const t = tasks.find((x) => x.id === id)
    if (!t) throw new Error(`Task ${id} not found`)
    Object.assign(t, changes, { updatedAt: Date.now() })
    return t
  },
  tasks_delete: async (args) => {
    const { id } = args as { id: string }
    const idx = tasks.findIndex((x) => x.id === id)
    if (idx >= 0) tasks.splice(idx, 1)
    return { ok: true }
  },
  tasks_reorder: async (args) => {
    const { ids } = (args as { ids: string[]; positions: number[] }) ?? {
      ids: [],
      positions: []
    }
    return { ok: true, reordered: ids.length }
  },

  // Projects — required by task sidebar + project pickers
  tasks_list_projects: async () => ({
    projects: [
      { id: 'project-1', name: 'Primary (Mock)', icon: null, archivedAt: null, position: 0 },
      { id: 'project-2', name: 'Side Quest (Mock)', icon: null, archivedAt: null, position: 1 }
    ]
  }),
  tasks_list_project_tasks: async (args) => {
    const { projectId } = args as { projectId: string }
    return tasks.filter((t) => t.projectId === projectId)
  },

  // Stats — used by sidebar counters and day panel overdue count
  tasks_get_stats: async () => ({
    total: tasks.length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    inProgress: tasks.filter((t) => t.status === 'in-progress').length,
    done: tasks.filter((t) => t.status === 'done').length,
    canceled: tasks.filter((t) => t.status === 'canceled').length,
    overdue: 0,
    dueToday: 0,
    dueSoon: 0
  }),

  // Status columns — per-project; required by kanban board
  tasks_list_statuses: async () => [
    { id: 'status-todo', name: 'Todo', color: '#94a3b8', position: 0 },
    { id: 'status-in-progress', name: 'In Progress', color: '#60a5fa', position: 1 },
    { id: 'status-done', name: 'Done', color: '#4ade80', position: 2 }
  ],
  tasks_get_tags: async () => [],
  tasks_get_today: async () => ({ tasks: [], total: 0, hasMore: false }),
  tasks_get_upcoming: async () => ({ tasks: [], total: 0, hasMore: false }),
  tasks_get_overdue: async () => ({ tasks: [], total: 0, hasMore: false }),
  tasks_get_linked_tasks: async () => []
}
