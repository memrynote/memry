/**
 * Task fixtures for testing.
 */

export interface TaskFixture {
  id: string
  projectId: string
  statusId: string | null
  parentId: string | null
  title: string
  description: string | null
  priority: 0 | 1 | 2 | 3 | 4
  position: number
  dueDate: string | null
  dueTime: string | null
  completedAt: string | null
  tags: string[]
  createdAt: string
  modifiedAt: string
}

export const sampleTasks: TaskFixture[] = [
  {
    id: 'task-1',
    projectId: 'project-1',
    statusId: null,
    parentId: null,
    title: 'Complete project setup',
    description: 'Set up the development environment',
    priority: 2,
    position: 0,
    dueDate: '2025-01-15',
    dueTime: null,
    completedAt: null,
    tags: ['setup', 'dev'],
    createdAt: '2025-01-01T00:00:00Z',
    modifiedAt: '2025-01-01T00:00:00Z'
  },
  {
    id: 'task-2',
    projectId: 'project-1',
    statusId: null,
    parentId: null,
    title: 'Write documentation',
    description: null,
    priority: 1,
    position: 1,
    dueDate: null,
    dueTime: null,
    completedAt: null,
    tags: ['docs'],
    createdAt: '2025-01-02T00:00:00Z',
    modifiedAt: '2025-01-02T00:00:00Z'
  },
  {
    id: 'task-3',
    projectId: 'project-1',
    statusId: null,
    parentId: 'task-1',
    title: 'Install dependencies',
    description: 'Run pnpm install',
    priority: 0,
    position: 0,
    dueDate: null,
    dueTime: null,
    completedAt: '2025-01-01T10:00:00Z',
    tags: [],
    createdAt: '2025-01-01T00:00:00Z',
    modifiedAt: '2025-01-01T10:00:00Z'
  }
]

export function createTaskFixture(overrides: Partial<TaskFixture> = {}): TaskFixture {
  return {
    id: overrides.id || `task-${Date.now()}`,
    projectId: overrides.projectId || 'project-1',
    statusId: overrides.statusId ?? null,
    parentId: overrides.parentId ?? null,
    title: overrides.title || 'Test Task',
    description: overrides.description ?? null,
    priority: overrides.priority ?? 0,
    position: overrides.position ?? 0,
    dueDate: overrides.dueDate ?? null,
    dueTime: overrides.dueTime ?? null,
    completedAt: overrides.completedAt ?? null,
    tags: overrides.tags || [],
    createdAt: overrides.createdAt || new Date().toISOString(),
    modifiedAt: overrides.modifiedAt || new Date().toISOString()
  }
}
