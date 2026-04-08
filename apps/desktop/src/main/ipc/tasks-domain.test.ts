import { describe, it, expect, vi } from 'vitest'
import { createTasksDomain } from '../../../../../packages/domain-tasks/src'

describe('createTasksDomain', () => {
  it('remaps the status when a task moves across projects', async () => {
    const existingTask = {
      id: 'task-1',
      projectId: 'project-a',
      statusId: 'status-a',
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
      createdAt: '2026-04-08T10:00:00.000Z',
      modifiedAt: '2026-04-08T10:00:00.000Z',
      tags: [],
      linkedNoteIds: []
    }

    const targetStatus = {
      id: 'status-b',
      projectId: 'project-b',
      name: 'Doing',
      color: '#123456',
      position: 1,
      isDefault: false,
      isDone: false,
      createdAt: '2026-04-08T10:00:00.000Z'
    }

    const updatedTask = {
      ...existingTask,
      projectId: 'project-b',
      statusId: 'status-b'
    }

    const repository = {
      getTask: vi.fn().mockReturnValue(existingTask),
      getStatus: vi.fn().mockReturnValue({
        id: 'status-a',
        projectId: 'project-a',
        name: 'Todo',
        color: '#654321',
        position: 0,
        isDefault: true,
        isDone: false,
        createdAt: '2026-04-08T10:00:00.000Z'
      }),
      getEquivalentStatus: vi.fn().mockReturnValue(targetStatus),
      updateTask: vi.fn().mockReturnValue(updatedTask)
    }

    const publisher = {
      taskUpdated: vi.fn()
    }

    const domain = createTasksDomain({
      repository,
      publisher
    })

    const result = await domain.updateTask({
      id: 'task-1',
      projectId: 'project-b'
    })

    expect(repository.getEquivalentStatus).toHaveBeenCalledWith('project-b', {
      id: 'status-a',
      projectId: 'project-a',
      name: 'Todo',
      color: '#654321',
      position: 0,
      isDefault: true,
      isDone: false,
      createdAt: '2026-04-08T10:00:00.000Z'
    })
    expect(repository.updateTask).toHaveBeenCalledWith('task-1', {
      projectId: 'project-b',
      statusId: 'status-b'
    })
    expect(publisher.taskUpdated).toHaveBeenCalledWith({
      id: 'task-1',
      task: updatedTask,
      changes: {
        projectId: 'project-b',
        statusId: 'status-b'
      },
      changedFields: ['projectId', 'statusId']
    })
    expect(result.task).toEqual(updatedTask)
  })
})
