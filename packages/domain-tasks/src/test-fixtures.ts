import { vi } from 'vitest'
import type {
  Project,
  ProjectWithStatuses,
  Status,
  Task,
  TaskListItem
} from './types.ts'
import type { TasksCommandRepository, TasksDomainPublisher } from './commands.ts'

export function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    statusId: 'status-1',
    parentId: null,
    title: 'Task',
    description: null,
    priority: 0,
    position: 0,
    dueDate: null,
    dueTime: null,
    startDate: null,
    repeatConfig: null,
    repeatFrom: null,
    sourceNoteId: null,
    completedAt: null,
    archivedAt: null,
    createdAt: '2026-04-16T10:00:00.000Z',
    modifiedAt: '2026-04-16T10:00:00.000Z',
    ...overrides
  }
}

export function createListItem(overrides: Partial<TaskListItem> = {}): TaskListItem {
  return {
    ...createTask(),
    tags: [],
    hasSubtasks: false,
    subtaskCount: 0,
    completedSubtaskCount: 0,
    linkedNoteIds: [],
    ...overrides
  }
}

export function createStatus(overrides: Partial<Status> = {}): Status {
  return {
    id: 'status-1',
    projectId: 'project-1',
    name: 'Todo',
    color: '#ccc',
    position: 0,
    isDefault: true,
    isDone: false,
    createdAt: '2026-04-16T10:00:00.000Z',
    ...overrides
  }
}

export function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project',
    description: null,
    color: '#6366f1',
    icon: null,
    position: 0,
    isInbox: false,
    createdAt: '2026-04-16T10:00:00.000Z',
    modifiedAt: '2026-04-16T10:00:00.000Z',
    archivedAt: null,
    ...overrides
  }
}

export function createProjectWithStatuses(
  overrides: Partial<ProjectWithStatuses> = {}
): ProjectWithStatuses {
  return {
    ...createProject(),
    statuses: [],
    ...overrides
  }
}

export function createCommandRepository(
  overrides: Partial<TasksCommandRepository> = {}
): TasksCommandRepository {
  return {
    getTask: vi.fn(() => undefined),
    listTasks: vi.fn(() => []),
    countTasks: vi.fn(() => 0),
    getSubtasks: vi.fn(() => []),
    listProjects: vi.fn(() => []),
    getProject: vi.fn(() => undefined),
    listStatuses: vi.fn(() => []),
    getAllTaskTags: vi.fn(() => []),
    getTaskStats: vi.fn(() => ({
      total: 0,
      completed: 0,
      overdue: 0,
      dueToday: 0,
      dueThisWeek: 0
    })),
    getTodayTasks: vi.fn(() => []),
    getUpcomingTasks: vi.fn(() => []),
    getOverdueTasks: vi.fn(() => []),
    getTasksLinkedToNote: vi.fn(() => []),
    createTask: vi.fn((t) => t as Task),
    updateTask: vi.fn(() => undefined),
    deleteTask: vi.fn(),
    completeTask: vi.fn(() => undefined),
    uncompleteTask: vi.fn(() => undefined),
    archiveTask: vi.fn(() => undefined),
    unarchiveTask: vi.fn(() => undefined),
    moveTask: vi.fn(() => undefined),
    reorderTasks: vi.fn(),
    duplicateTask: vi.fn(() => undefined),
    duplicateSubtask: vi.fn(() => undefined),
    getTaskTags: vi.fn(() => []),
    setTaskTags: vi.fn(),
    getTaskNoteIds: vi.fn(() => []),
    setTaskNotes: vi.fn(),
    getNextTaskPosition: vi.fn(() => 0),
    getStatus: vi.fn(() => undefined),
    getEquivalentStatus: vi.fn(() => undefined),
    createProject: vi.fn((p) => ({ ...p, createdAt: 'n', modifiedAt: 'n', archivedAt: null })),
    updateProject: vi.fn(() => undefined),
    deleteProject: vi.fn(),
    archiveProject: vi.fn(() => undefined),
    reorderProjects: vi.fn(),
    getNextProjectPosition: vi.fn(() => 0),
    createDefaultStatuses: vi.fn(() => []),
    createCustomStatuses: vi.fn(() => []),
    reconcileProjectStatuses: vi.fn(),
    createStatus: vi.fn((s) => ({ ...s, createdAt: 'n' })),
    updateStatus: vi.fn(() => undefined),
    deleteStatus: vi.fn(),
    reorderStatuses: vi.fn(),
    getNextStatusPosition: vi.fn(() => 0),
    bulkCompleteTasks: vi.fn(() => 0),
    bulkDeleteTasks: vi.fn(() => 0),
    bulkMoveTasks: vi.fn(() => 0),
    bulkArchiveTasks: vi.fn(() => 0),
    ...overrides
  }
}

export function createPublisher(
  overrides: Partial<TasksDomainPublisher> = {}
): TasksDomainPublisher {
  return {
    taskCreated: vi.fn(async () => {}),
    taskUpdated: vi.fn(async () => {}),
    taskDeleted: vi.fn(async () => {}),
    taskCompleted: vi.fn(async () => {}),
    taskMoved: vi.fn(async () => {}),
    taskReordered: vi.fn(async () => {}),
    projectCreated: vi.fn(async () => {}),
    projectUpdated: vi.fn(async () => {}),
    projectDeleted: vi.fn(async () => {}),
    statusCreated: vi.fn(async () => {}),
    statusUpdated: vi.fn(async () => {}),
    statusDeleted: vi.fn(async () => {}),
    ...overrides
  }
}
