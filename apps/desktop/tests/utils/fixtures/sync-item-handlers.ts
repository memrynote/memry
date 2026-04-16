import { vi } from 'vitest'
import type { TestDatabaseResult } from '@tests/utils/test-db'
import type { NoteSyncPayload, TaskSyncPayload } from '@memry/contracts/sync-payloads'
import type { ApplyContext, DrizzleDb } from '../types'

export const TEST_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  color: '#000',
  position: 0,
  isInbox: false
} as const

export const TEST_STATUSES = [
  {
    id: 'status-todo',
    projectId: 'proj-1',
    name: 'Todo',
    color: '#6b7280',
    position: 0,
    isDefault: true,
    isDone: false
  },
  {
    id: 'status-done',
    projectId: 'proj-1',
    name: 'Done',
    color: '#22c55e',
    position: 1,
    isDefault: false,
    isDone: true
  }
] as const

export function makeCtx(testDb?: TestDatabaseResult): ApplyContext {
  return {
    db: (testDb?.db as unknown as DrizzleDb) ?? ({} as DrizzleDb),
    emit: vi.fn()
  }
}

export function makeTaskPayload(overrides: Partial<TaskSyncPayload> = {}): TaskSyncPayload {
  return {
    title: 'Task',
    description: null,
    projectId: 'proj-1',
    statusId: 'status-todo',
    parentId: null,
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
    modifiedAt: '2026-02-23T00:00:00.000Z',
    ...overrides
  }
}

export function makeNotePayload(overrides: Partial<NoteSyncPayload> = {}): NoteSyncPayload {
  return {
    title: 'a1',
    content: 'test content',
    folderPath: 'a1',
    createdAt: '2024-01-01T00:00:00.000Z',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    tags: [],
    ...overrides
  }
}
