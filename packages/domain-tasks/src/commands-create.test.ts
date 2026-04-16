import { describe, expect, it, vi } from 'vitest'
import { createTasksCommands } from './commands.ts'
import {
  createCommandRepository,
  createPublisher,
  createStatus,
  createTask
} from './test-fixtures.ts'

function buildDeps(overrides: Parameters<typeof createCommandRepository>[0] = {}) {
  let seq = 0
  const generateId = vi.fn(() => `gen-${++seq}`)
  const repository = createCommandRepository(overrides)
  const publisher = createPublisher()
  return { repository, publisher, generateId }
}

describe('createTasksCommands — create/update/delete task', () => {
  describe('createTask', () => {
    it('creates a task, persists tags and links, publishes event, returns success', async () => {
      // #given
      const createdTask = createTask({ id: 'gen-1' })
      const deps = buildDeps({
        getNextTaskPosition: vi.fn(() => 42),
        createTask: vi.fn(() => createdTask)
      })
      const commands = createTasksCommands(deps)

      // #when
      const result = await commands.createTask({
        projectId: 'p1',
        title: 'New task',
        tags: ['urgent'],
        linkedNoteIds: ['note-1']
      })

      // #then
      expect(result.success).toBe(true)
      expect(result.task?.tags).toEqual(['urgent'])
      expect(result.task?.linkedNoteIds).toEqual(['note-1'])
      expect(deps.repository.createTask).toHaveBeenCalled()
      expect(deps.repository.setTaskTags).toHaveBeenCalledWith('gen-1', ['urgent'])
      expect(deps.repository.setTaskNotes).toHaveBeenCalledWith('gen-1', ['note-1'])
      expect(deps.publisher.taskCreated).toHaveBeenCalledWith({ task: result.task })
    })

    it('falls back to repository.getNextTaskPosition when position not supplied', async () => {
      const deps = buildDeps({
        getNextTaskPosition: vi.fn(() => 7),
        createTask: vi.fn(() => createTask({ id: 'gen-1', position: 7 }))
      })
      const commands = createTasksCommands(deps)

      await commands.createTask({ projectId: 'p1', title: 'T' })

      expect(deps.repository.getNextTaskPosition).toHaveBeenCalledWith('p1', undefined)
      expect(deps.repository.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ position: 7 })
      )
    })

    it('uses explicit position when supplied', async () => {
      const deps = buildDeps({
        createTask: vi.fn(() => createTask({ id: 'gen-1', position: 100 }))
      })
      const commands = createTasksCommands(deps)

      await commands.createTask({ projectId: 'p1', title: 'T', position: 100 })

      expect(deps.repository.getNextTaskPosition).not.toHaveBeenCalled()
      expect(deps.repository.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ position: 100 })
      )
    })

    it('skips tag/link writes when arrays are empty', async () => {
      const deps = buildDeps({
        createTask: vi.fn(() => createTask({ id: 'gen-1' }))
      })
      const commands = createTasksCommands(deps)

      await commands.createTask({ projectId: 'p1', title: 'T', tags: [], linkedNoteIds: [] })

      expect(deps.repository.setTaskTags).not.toHaveBeenCalled()
      expect(deps.repository.setTaskNotes).not.toHaveBeenCalled()
    })

    it('does not mutate the input object', async () => {
      const deps = buildDeps({
        createTask: vi.fn(() => createTask({ id: 'gen-1' }))
      })
      const commands = createTasksCommands(deps)
      const input = { projectId: 'p1', title: 'T', tags: ['a'] }
      const snapshot = JSON.stringify(input)

      await commands.createTask(input)

      expect(JSON.stringify(input)).toBe(snapshot)
    })

    it('propagates repository errors', async () => {
      const deps = buildDeps({
        createTask: vi.fn(() => {
          throw new Error('db write failed')
        })
      })
      const commands = createTasksCommands(deps)

      await expect(
        commands.createTask({ projectId: 'p1', title: 'T' })
      ).rejects.toThrow('db write failed')
    })
  })

  describe('deleteTask', () => {
    it('snapshots task, deletes, publishes with snapshot', async () => {
      const snapshot = createTask()
      const deps = buildDeps({
        getTask: vi.fn(() => snapshot)
      })
      const commands = createTasksCommands(deps)

      const result = await commands.deleteTask('task-1')

      expect(result).toEqual({ success: true })
      expect(deps.repository.deleteTask).toHaveBeenCalledWith('task-1')
      expect(deps.publisher.taskDeleted).toHaveBeenCalledWith({ id: 'task-1', snapshot })
    })

    it('publishes with undefined snapshot when task missing', async () => {
      const deps = buildDeps()
      const commands = createTasksCommands(deps)

      await commands.deleteTask('missing')

      expect(deps.publisher.taskDeleted).toHaveBeenCalledWith({
        id: 'missing',
        snapshot: undefined
      })
    })
  })

  describe('createProject', () => {
    it('creates project with defaults, adds default statuses, publishes event', async () => {
      const createdProject = {
        id: 'gen-1',
        name: 'New',
        description: null,
        color: '#6366f1',
        icon: null,
        position: 5,
        isInbox: false,
        createdAt: 'now',
        modifiedAt: 'now',
        archivedAt: null,
        statuses: []
      }
      const deps = buildDeps({
        getNextProjectPosition: vi.fn(() => 5),
        createProject: vi.fn((p) => ({ ...p, createdAt: 'now', modifiedAt: 'now', archivedAt: null })),
        getProject: vi.fn(() => createdProject)
      })
      const commands = createTasksCommands(deps)

      const result = await commands.createProject({ name: 'New' })

      expect(result).toEqual({ success: true, project: createdProject })
      expect(deps.repository.createDefaultStatuses).toHaveBeenCalledWith('gen-1')
      expect(deps.repository.createCustomStatuses).not.toHaveBeenCalled()
      expect(deps.publisher.projectCreated).toHaveBeenCalled()
    })

    it('creates custom statuses when ≥2 provided', async () => {
      const createdProject = {
        id: 'gen-1',
        name: 'N',
        description: null,
        color: '#abc',
        icon: null,
        position: 0,
        isInbox: false,
        createdAt: 'n',
        modifiedAt: 'n',
        archivedAt: null,
        statuses: []
      }
      const deps = buildDeps({
        createProject: vi.fn((p) => ({ ...p, createdAt: 'n', modifiedAt: 'n', archivedAt: null })),
        getProject: vi.fn(() => createdProject)
      })
      const commands = createTasksCommands(deps)

      await commands.createProject({
        name: 'N',
        color: '#abc',
        statuses: [
          { name: 'Todo', color: '#111', type: 'todo', order: 0 },
          { name: 'Done', color: '#222', type: 'done', order: 1 }
        ]
      })

      expect(deps.repository.createCustomStatuses).toHaveBeenCalled()
      expect(deps.repository.createDefaultStatuses).not.toHaveBeenCalled()
    })

    it('falls back to default statuses when only one custom status supplied', async () => {
      const deps = buildDeps({
        createProject: vi.fn((p) => ({ ...p, createdAt: 'n', modifiedAt: 'n', archivedAt: null })),
        getProject: vi.fn(() => ({
          id: 'gen-1',
          name: 'N',
          description: null,
          color: '#6366f1',
          icon: null,
          position: 0,
          isInbox: false,
          createdAt: 'n',
          modifiedAt: 'n',
          archivedAt: null,
          statuses: []
        }))
      })
      const commands = createTasksCommands(deps)

      await commands.createProject({
        name: 'N',
        statuses: [{ name: 'Only', color: '#111', type: 'todo', order: 0 }]
      })

      expect(deps.repository.createDefaultStatuses).toHaveBeenCalled()
      expect(deps.repository.createCustomStatuses).not.toHaveBeenCalled()
    })

    it('throws when project cannot be reloaded after create', async () => {
      const deps = buildDeps({
        createProject: vi.fn((p) => ({ ...p, createdAt: 'n', modifiedAt: 'n', archivedAt: null })),
        getProject: vi.fn(() => undefined)
      })
      const commands = createTasksCommands(deps)

      await expect(commands.createProject({ name: 'X' })).rejects.toThrow(
        'Project not found after create'
      )
    })
  })

  describe('createStatus', () => {
    it('creates with next position, color default, publishes event', async () => {
      const status = createStatus({ id: 'gen-1', projectId: 'p1' })
      const deps = buildDeps({
        getNextStatusPosition: vi.fn(() => 3),
        createStatus: vi.fn(() => status)
      })
      const commands = createTasksCommands(deps)

      const result = await commands.createStatus({ projectId: 'p1', name: 'Blocked' })

      expect(result).toEqual({ success: true, status })
      expect(deps.repository.createStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'gen-1',
          projectId: 'p1',
          name: 'Blocked',
          color: '#6b7280',
          position: 3,
          isDefault: false,
          isDone: false
        })
      )
      expect(deps.publisher.statusCreated).toHaveBeenCalledWith({ status })
    })

    it('respects provided color and isDone', async () => {
      const deps = buildDeps({
        createStatus: vi.fn((s) => ({ ...s, createdAt: 'n' }))
      })
      const commands = createTasksCommands(deps)

      await commands.createStatus({
        projectId: 'p1',
        name: 'Done',
        color: '#00ff00',
        isDone: true
      })

      expect(deps.repository.createStatus).toHaveBeenCalledWith(
        expect.objectContaining({ color: '#00ff00', isDone: true })
      )
    })
  })
})
