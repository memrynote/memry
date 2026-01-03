/**
 * Tasks API Contract Tests
 *
 * Comprehensive Zod schema validation tests for the tasks API contract.
 * Tests both valid and invalid inputs for all schemas.
 */

import { describe, it, expect } from 'vitest'
import {
  RepeatConfigSchema,
  TaskCreateSchema,
  TaskUpdateSchema,
  TaskCompleteSchema,
  TaskMoveSchema,
  TaskListSchema,
  ProjectCreateSchema,
  ProjectUpdateSchema,
  StatusCreateSchema,
  StatusUpdateSchema,
  TaskReorderSchema,
  ConvertToSubtaskSchema,
  ProjectReorderSchema,
  StatusReorderSchema,
  BulkIdsSchema,
  BulkMoveSchema,
  GetUpcomingSchema,
  RenameFolderSchema
} from './tasks-api'

// ============================================================================
// RepeatConfigSchema Tests
// ============================================================================

describe('RepeatConfigSchema', () => {
  it('should validate minimal daily config', () => {
    const result = RepeatConfigSchema.safeParse({
      frequency: 'daily',
      interval: 1,
      endType: 'never',
      completedCount: 0,
      createdAt: '2026-01-03T10:00:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('should validate weekly config with daysOfWeek', () => {
    const result = RepeatConfigSchema.safeParse({
      frequency: 'weekly',
      interval: 2,
      daysOfWeek: [1, 3, 5], // Mon, Wed, Fri
      endType: 'count',
      endCount: 10,
      completedCount: 3,
      createdAt: '2026-01-03T10:00:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('should validate monthly config with dayOfMonth', () => {
    const result = RepeatConfigSchema.safeParse({
      frequency: 'monthly',
      interval: 1,
      monthlyType: 'dayOfMonth',
      dayOfMonth: 15,
      endType: 'date',
      endDate: '2026-12-31',
      completedCount: 0,
      createdAt: '2026-01-03T10:00:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('should validate monthly config with weekPattern', () => {
    const result = RepeatConfigSchema.safeParse({
      frequency: 'monthly',
      interval: 1,
      monthlyType: 'weekPattern',
      weekOfMonth: 2,
      dayOfWeekForMonth: 1, // 2nd Monday
      endType: 'never',
      completedCount: 0,
      createdAt: '2026-01-03T10:00:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('should validate yearly config', () => {
    const result = RepeatConfigSchema.safeParse({
      frequency: 'yearly',
      interval: 1,
      endType: 'never',
      completedCount: 0,
      createdAt: '2026-01-03T10:00:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid frequency', () => {
    const result = RepeatConfigSchema.safeParse({
      frequency: 'biweekly',
      interval: 1,
      endType: 'never',
      completedCount: 0,
      createdAt: '2026-01-03T10:00:00Z'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('frequency')
    }
  })

  it('should reject interval less than 1', () => {
    const result = RepeatConfigSchema.safeParse({
      frequency: 'daily',
      interval: 0,
      endType: 'never',
      completedCount: 0,
      createdAt: '2026-01-03T10:00:00Z'
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid daysOfWeek values', () => {
    const result = RepeatConfigSchema.safeParse({
      frequency: 'weekly',
      interval: 1,
      daysOfWeek: [0, 7], // 7 is invalid
      endType: 'never',
      completedCount: 0,
      createdAt: '2026-01-03T10:00:00Z'
    })
    expect(result.success).toBe(false)
  })

  it('should reject dayOfMonth out of range', () => {
    const result = RepeatConfigSchema.safeParse({
      frequency: 'monthly',
      interval: 1,
      dayOfMonth: 32,
      endType: 'never',
      completedCount: 0,
      createdAt: '2026-01-03T10:00:00Z'
    })
    expect(result.success).toBe(false)
  })

  it('should reject negative completedCount', () => {
    const result = RepeatConfigSchema.safeParse({
      frequency: 'daily',
      interval: 1,
      endType: 'never',
      completedCount: -1,
      createdAt: '2026-01-03T10:00:00Z'
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing required fields', () => {
    const result = RepeatConfigSchema.safeParse({
      frequency: 'daily'
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// TaskCreateSchema Tests
// ============================================================================

describe('TaskCreateSchema', () => {
  it('should validate minimal valid input', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test Task'
    })
    expect(result.success).toBe(true)
  })

  it('should validate full valid input', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test Task',
      description: 'This is a detailed description',
      priority: 2,
      statusId: 'status-1',
      parentId: 'task-parent',
      dueDate: '2026-01-15',
      dueTime: '14:30',
      startDate: '2026-01-10',
      isRepeating: true,
      repeatConfig: {
        frequency: 'weekly',
        interval: 1,
        endType: 'never',
        completedCount: 0,
        createdAt: '2026-01-03T10:00:00Z'
      },
      repeatFrom: 'due',
      tags: ['work', 'urgent'],
      linkedNoteIds: ['note-1', 'note-2'],
      sourceNoteId: 'note-source',
      position: 5
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty title', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: ''
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('title')
    }
  })

  it('should reject title over 500 chars', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'x'.repeat(501)
    })
    expect(result.success).toBe(false)
  })

  it('should accept title at 500 chars boundary', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'x'.repeat(500)
    })
    expect(result.success).toBe(true)
  })

  it('should reject description over 10000 chars', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      description: 'x'.repeat(10001)
    })
    expect(result.success).toBe(false)
  })

  it('should accept description at 10000 chars boundary', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      description: 'x'.repeat(10000)
    })
    expect(result.success).toBe(true)
  })

  it('should accept null description', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      description: null
    })
    expect(result.success).toBe(true)
  })

  it('should reject priority out of range (negative)', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      priority: -1
    })
    expect(result.success).toBe(false)
  })

  it('should reject priority out of range (too high)', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      priority: 5
    })
    expect(result.success).toBe(false)
  })

  it('should accept priority at boundaries (0 and 4)', () => {
    const result0 = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      priority: 0
    })
    expect(result0.success).toBe(true)

    const result4 = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      priority: 4
    })
    expect(result4.success).toBe(true)
  })

  it('should reject invalid dueDate format', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      dueDate: '01-15-2026' // wrong format
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid dueDate format (ISO datetime)', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      dueDate: '2026-01-15T10:00:00Z'
    })
    expect(result.success).toBe(false)
  })

  it('should accept valid dueDate format', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      dueDate: '2026-01-15'
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid dueTime format', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      dueTime: '2:30 PM'
    })
    expect(result.success).toBe(false)
  })

  it('should accept valid dueTime format', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      dueTime: '14:30'
    })
    expect(result.success).toBe(true)
  })

  it('should reject tags with more than 20 items', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`)
    })
    expect(result.success).toBe(false)
  })

  it('should reject tag over 50 chars', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      tags: ['x'.repeat(51)]
    })
    expect(result.success).toBe(false)
  })

  it('should accept repeatFrom values', () => {
    const resultDue = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      repeatFrom: 'due'
    })
    expect(resultDue.success).toBe(true)

    const resultCompletion = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      repeatFrom: 'completion'
    })
    expect(resultCompletion.success).toBe(true)
  })

  it('should reject invalid repeatFrom value', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Test',
      repeatFrom: 'start'
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing projectId', () => {
    const result = TaskCreateSchema.safeParse({
      title: 'Test'
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// TaskUpdateSchema Tests
// ============================================================================

describe('TaskUpdateSchema', () => {
  it('should validate with only id', () => {
    const result = TaskUpdateSchema.safeParse({
      id: 'task-1'
    })
    expect(result.success).toBe(true)
  })

  it('should validate full update', () => {
    const result = TaskUpdateSchema.safeParse({
      id: 'task-1',
      title: 'Updated Title',
      description: 'Updated description',
      priority: 3,
      projectId: 'proj-2',
      statusId: 'status-2',
      parentId: 'task-parent',
      dueDate: '2026-02-01',
      dueTime: '09:00',
      startDate: '2026-01-25',
      isRepeating: false,
      repeatConfig: null,
      repeatFrom: null,
      tags: ['updated'],
      linkedNoteIds: ['note-3']
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing id', () => {
    const result = TaskUpdateSchema.safeParse({
      title: 'Updated Title'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('id')
    }
  })

  it('should reject empty title', () => {
    const result = TaskUpdateSchema.safeParse({
      id: 'task-1',
      title: ''
    })
    expect(result.success).toBe(false)
  })

  it('should allow clearing optional fields with null', () => {
    const result = TaskUpdateSchema.safeParse({
      id: 'task-1',
      description: null,
      statusId: null,
      parentId: null,
      dueDate: null,
      dueTime: null
    })
    expect(result.success).toBe(true)
  })
})

// ============================================================================
// TaskCompleteSchema Tests
// ============================================================================

describe('TaskCompleteSchema', () => {
  it('should validate with only id', () => {
    const result = TaskCompleteSchema.safeParse({
      id: 'task-1'
    })
    expect(result.success).toBe(true)
  })

  it('should validate with completedAt datetime', () => {
    const result = TaskCompleteSchema.safeParse({
      id: 'task-1',
      completedAt: '2026-01-03T15:30:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid completedAt format', () => {
    const result = TaskCompleteSchema.safeParse({
      id: 'task-1',
      completedAt: '2026-01-03'
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing id', () => {
    const result = TaskCompleteSchema.safeParse({
      completedAt: '2026-01-03T15:30:00Z'
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// TaskMoveSchema Tests
// ============================================================================

describe('TaskMoveSchema', () => {
  it('should validate minimal move', () => {
    const result = TaskMoveSchema.safeParse({
      taskId: 'task-1',
      position: 0
    })
    expect(result.success).toBe(true)
  })

  it('should validate full move with all options', () => {
    const result = TaskMoveSchema.safeParse({
      taskId: 'task-1',
      targetProjectId: 'proj-2',
      targetStatusId: 'status-2',
      targetParentId: 'task-parent',
      position: 5
    })
    expect(result.success).toBe(true)
  })

  it('should allow null targetStatusId', () => {
    const result = TaskMoveSchema.safeParse({
      taskId: 'task-1',
      targetStatusId: null,
      position: 0
    })
    expect(result.success).toBe(true)
  })

  it('should allow null targetParentId', () => {
    const result = TaskMoveSchema.safeParse({
      taskId: 'task-1',
      targetParentId: null,
      position: 0
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing taskId', () => {
    const result = TaskMoveSchema.safeParse({
      position: 0
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing position', () => {
    const result = TaskMoveSchema.safeParse({
      taskId: 'task-1'
    })
    expect(result.success).toBe(false)
  })

  it('should reject non-integer position', () => {
    const result = TaskMoveSchema.safeParse({
      taskId: 'task-1',
      position: 1.5
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// TaskListSchema Tests
// ============================================================================

describe('TaskListSchema', () => {
  it('should validate empty object with defaults', () => {
    const result = TaskListSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.includeCompleted).toBe(false)
      expect(result.data.includeArchived).toBe(false)
      expect(result.data.sortBy).toBe('position')
      expect(result.data.sortOrder).toBe('asc')
      expect(result.data.limit).toBe(100)
      expect(result.data.offset).toBe(0)
    }
  })

  it('should validate full query', () => {
    const result = TaskListSchema.safeParse({
      projectId: 'proj-1',
      statusId: 'status-1',
      parentId: 'task-parent',
      includeCompleted: true,
      includeArchived: true,
      dueBefore: '2026-01-31',
      dueAfter: '2026-01-01',
      tags: ['work', 'urgent'],
      search: 'meeting',
      sortBy: 'dueDate',
      sortOrder: 'desc',
      limit: 50,
      offset: 10
    })
    expect(result.success).toBe(true)
  })

  it('should validate all sortBy values', () => {
    const sortByValues = ['position', 'dueDate', 'priority', 'created', 'modified'] as const
    for (const sortBy of sortByValues) {
      const result = TaskListSchema.safeParse({ sortBy })
      expect(result.success).toBe(true)
    }
  })

  it('should reject invalid sortBy value', () => {
    const result = TaskListSchema.safeParse({
      sortBy: 'title'
    })
    expect(result.success).toBe(false)
  })

  it('should reject limit below 1', () => {
    const result = TaskListSchema.safeParse({
      limit: 0
    })
    expect(result.success).toBe(false)
  })

  it('should reject limit above 1000', () => {
    const result = TaskListSchema.safeParse({
      limit: 1001
    })
    expect(result.success).toBe(false)
  })

  it('should accept limit at boundaries (1 and 1000)', () => {
    const result1 = TaskListSchema.safeParse({ limit: 1 })
    expect(result1.success).toBe(true)

    const result1000 = TaskListSchema.safeParse({ limit: 1000 })
    expect(result1000.success).toBe(true)
  })

  it('should reject negative offset', () => {
    const result = TaskListSchema.safeParse({
      offset: -1
    })
    expect(result.success).toBe(false)
  })

  it('should accept offset at 0', () => {
    const result = TaskListSchema.safeParse({
      offset: 0
    })
    expect(result.success).toBe(true)
  })
})

// ============================================================================
// ProjectCreateSchema Tests
// ============================================================================

describe('ProjectCreateSchema', () => {
  it('should validate minimal input', () => {
    const result = ProjectCreateSchema.safeParse({
      name: 'My Project'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.color).toBe('#6366f1') // default
    }
  })

  it('should validate full input', () => {
    const result = ProjectCreateSchema.safeParse({
      name: 'My Project',
      description: 'A detailed description',
      color: '#ff5733',
      icon: 'folder'
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty name', () => {
    const result = ProjectCreateSchema.safeParse({
      name: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject name over 100 chars', () => {
    const result = ProjectCreateSchema.safeParse({
      name: 'x'.repeat(101)
    })
    expect(result.success).toBe(false)
  })

  it('should accept name at 100 chars boundary', () => {
    const result = ProjectCreateSchema.safeParse({
      name: 'x'.repeat(100)
    })
    expect(result.success).toBe(true)
  })

  it('should reject description over 500 chars', () => {
    const result = ProjectCreateSchema.safeParse({
      name: 'My Project',
      description: 'x'.repeat(501)
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid hex color format', () => {
    const invalidColors = ['red', '#fff', '#gggggg', 'ff5733', '#ff573']
    for (const color of invalidColors) {
      const result = ProjectCreateSchema.safeParse({
        name: 'My Project',
        color
      })
      expect(result.success).toBe(false)
    }
  })

  it('should accept valid hex color formats', () => {
    const validColors = ['#ff5733', '#FF5733', '#aAbBcC', '#000000', '#FFFFFF']
    for (const color of validColors) {
      const result = ProjectCreateSchema.safeParse({
        name: 'My Project',
        color
      })
      expect(result.success).toBe(true)
    }
  })

  it('should accept null icon', () => {
    const result = ProjectCreateSchema.safeParse({
      name: 'My Project',
      icon: null
    })
    expect(result.success).toBe(true)
  })
})

// ============================================================================
// ProjectUpdateSchema Tests
// ============================================================================

describe('ProjectUpdateSchema', () => {
  it('should validate with only id', () => {
    const result = ProjectUpdateSchema.safeParse({
      id: 'proj-1'
    })
    expect(result.success).toBe(true)
  })

  it('should validate full update', () => {
    const result = ProjectUpdateSchema.safeParse({
      id: 'proj-1',
      name: 'Updated Name',
      description: 'Updated description',
      color: '#abcdef',
      icon: 'star'
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing id', () => {
    const result = ProjectUpdateSchema.safeParse({
      name: 'Updated Name'
    })
    expect(result.success).toBe(false)
  })

  it('should allow clearing description with null', () => {
    const result = ProjectUpdateSchema.safeParse({
      id: 'proj-1',
      description: null
    })
    expect(result.success).toBe(true)
  })
})

// ============================================================================
// StatusCreateSchema Tests
// ============================================================================

describe('StatusCreateSchema', () => {
  it('should validate minimal input', () => {
    const result = StatusCreateSchema.safeParse({
      projectId: 'proj-1',
      name: 'To Do'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.color).toBe('#6b7280') // default
      expect(result.data.isDone).toBe(false) // default
    }
  })

  it('should validate full input', () => {
    const result = StatusCreateSchema.safeParse({
      projectId: 'proj-1',
      name: 'Done',
      color: '#22c55e',
      isDone: true
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty name', () => {
    const result = StatusCreateSchema.safeParse({
      projectId: 'proj-1',
      name: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject name over 50 chars', () => {
    const result = StatusCreateSchema.safeParse({
      projectId: 'proj-1',
      name: 'x'.repeat(51)
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing projectId', () => {
    const result = StatusCreateSchema.safeParse({
      name: 'To Do'
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid color format', () => {
    const result = StatusCreateSchema.safeParse({
      projectId: 'proj-1',
      name: 'To Do',
      color: 'blue'
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// StatusUpdateSchema Tests
// ============================================================================

describe('StatusUpdateSchema', () => {
  it('should validate with only id', () => {
    const result = StatusUpdateSchema.safeParse({
      id: 'status-1'
    })
    expect(result.success).toBe(true)
  })

  it('should validate full update', () => {
    const result = StatusUpdateSchema.safeParse({
      id: 'status-1',
      name: 'In Progress',
      color: '#3b82f6',
      position: 2,
      isDefault: true,
      isDone: false
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing id', () => {
    const result = StatusUpdateSchema.safeParse({
      name: 'In Progress'
    })
    expect(result.success).toBe(false)
  })

  it('should reject non-integer position', () => {
    const result = StatusUpdateSchema.safeParse({
      id: 'status-1',
      position: 1.5
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// TaskReorderSchema Tests
// ============================================================================

describe('TaskReorderSchema', () => {
  it('should validate matching arrays', () => {
    const result = TaskReorderSchema.safeParse({
      taskIds: ['task-1', 'task-2', 'task-3'],
      positions: [0, 1, 2]
    })
    expect(result.success).toBe(true)
  })

  it('should validate empty arrays', () => {
    const result = TaskReorderSchema.safeParse({
      taskIds: [],
      positions: []
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing taskIds', () => {
    const result = TaskReorderSchema.safeParse({
      positions: [0, 1, 2]
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing positions', () => {
    const result = TaskReorderSchema.safeParse({
      taskIds: ['task-1', 'task-2']
    })
    expect(result.success).toBe(false)
  })

  it('should reject non-integer positions', () => {
    const result = TaskReorderSchema.safeParse({
      taskIds: ['task-1'],
      positions: [1.5]
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// ConvertToSubtaskSchema Tests
// ============================================================================

describe('ConvertToSubtaskSchema', () => {
  it('should validate valid input', () => {
    const result = ConvertToSubtaskSchema.safeParse({
      taskId: 'task-1',
      parentId: 'task-parent'
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing taskId', () => {
    const result = ConvertToSubtaskSchema.safeParse({
      parentId: 'task-parent'
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing parentId', () => {
    const result = ConvertToSubtaskSchema.safeParse({
      taskId: 'task-1'
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// ProjectReorderSchema Tests
// ============================================================================

describe('ProjectReorderSchema', () => {
  it('should validate matching arrays', () => {
    const result = ProjectReorderSchema.safeParse({
      projectIds: ['proj-1', 'proj-2'],
      positions: [0, 1]
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing projectIds', () => {
    const result = ProjectReorderSchema.safeParse({
      positions: [0, 1]
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// StatusReorderSchema Tests
// ============================================================================

describe('StatusReorderSchema', () => {
  it('should validate matching arrays', () => {
    const result = StatusReorderSchema.safeParse({
      statusIds: ['status-1', 'status-2'],
      positions: [0, 1]
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing statusIds', () => {
    const result = StatusReorderSchema.safeParse({
      positions: [0, 1]
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// BulkIdsSchema Tests
// ============================================================================

describe('BulkIdsSchema', () => {
  it('should validate array of ids', () => {
    const result = BulkIdsSchema.safeParse({
      ids: ['id-1', 'id-2', 'id-3']
    })
    expect(result.success).toBe(true)
  })

  it('should validate empty array', () => {
    const result = BulkIdsSchema.safeParse({
      ids: []
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing ids', () => {
    const result = BulkIdsSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('should reject non-string ids', () => {
    const result = BulkIdsSchema.safeParse({
      ids: [1, 2, 3]
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// BulkMoveSchema Tests
// ============================================================================

describe('BulkMoveSchema', () => {
  it('should validate valid input', () => {
    const result = BulkMoveSchema.safeParse({
      ids: ['task-1', 'task-2'],
      projectId: 'proj-1'
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing ids', () => {
    const result = BulkMoveSchema.safeParse({
      projectId: 'proj-1'
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing projectId', () => {
    const result = BulkMoveSchema.safeParse({
      ids: ['task-1', 'task-2']
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// GetUpcomingSchema Tests
// ============================================================================

describe('GetUpcomingSchema', () => {
  it('should validate with default days', () => {
    const result = GetUpcomingSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.days).toBe(7) // default
    }
  })

  it('should validate custom days', () => {
    const result = GetUpcomingSchema.safeParse({
      days: 30
    })
    expect(result.success).toBe(true)
  })

  it('should reject days below 1', () => {
    const result = GetUpcomingSchema.safeParse({
      days: 0
    })
    expect(result.success).toBe(false)
  })

  it('should reject days above 365', () => {
    const result = GetUpcomingSchema.safeParse({
      days: 366
    })
    expect(result.success).toBe(false)
  })

  it('should accept days at boundaries (1 and 365)', () => {
    const result1 = GetUpcomingSchema.safeParse({ days: 1 })
    expect(result1.success).toBe(true)

    const result365 = GetUpcomingSchema.safeParse({ days: 365 })
    expect(result365.success).toBe(true)
  })
})

// ============================================================================
// RenameFolderSchema Tests
// ============================================================================

describe('RenameFolderSchema', () => {
  it('should validate valid input', () => {
    const result = RenameFolderSchema.safeParse({
      oldPath: '/notes/old-folder',
      newPath: '/notes/new-folder'
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing oldPath', () => {
    const result = RenameFolderSchema.safeParse({
      newPath: '/notes/new-folder'
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing newPath', () => {
    const result = RenameFolderSchema.safeParse({
      oldPath: '/notes/old-folder'
    })
    expect(result.success).toBe(false)
  })
})
