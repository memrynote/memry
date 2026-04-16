import { describe, expect, it, vi } from 'vitest'
import { createTasksCommands } from './commands.ts'
import {
  createCommandRepository,
  createProjectWithStatuses,
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

describe('createTasksCommands — update/delete/complete/archive task', () => {
  describe('updateTask', () => {
    it('returns error when task not found', async () => {
      const deps = buildDeps({ updateTask: vi.fn(() => undefined) })
      const commands = createTasksCommands(deps)

      const result = await commands.updateTask({ id: 'missing', title: 'x' })

      expect(result).toEqual({ success: false, task: null, error: 'Task not found' })
      expect(deps.publisher.taskUpdated).not.toHaveBeenCalled()
    })

    it('updates fields, persists tags/links, publishes changed fields', async () => {
      const existing = createTask({ title: 'Old', description: 'Old desc' })
      const updated = createTask({ title: 'New', description: 'New desc' })
      const deps = buildDeps({
        getTask: vi.fn(() => existing),
        getTaskTags: vi.fn(() => ['old']),
        getTaskNoteIds: vi.fn(() => ['note-a']),
        updateTask: vi.fn(() => updated)
      })
      const commands = createTasksCommands(deps)

      const result = await commands.updateTask({
        id: 'task-1',
        title: 'New',
        description: 'New desc',
        tags: ['new'],
        linkedNoteIds: ['note-b']
      })

      expect(result.success).toBe(true)
      expect(result.task?.tags).toEqual(['new'])
      expect(result.task?.linkedNoteIds).toEqual(['note-b'])
      expect(deps.repository.setTaskTags).toHaveBeenCalledWith('task-1', ['new'])
      expect(deps.repository.setTaskNotes).toHaveBeenCalledWith('task-1', ['note-b'])

      const publishCall = vi.mocked(deps.publisher.taskUpdated).mock.calls[0][0]
      expect(publishCall.changedFields).toEqual(
        expect.arrayContaining(['title', 'description', 'tags', 'linkedNoteIds'])
      )
    })

    it('coerces priority to Task["priority"] shape', async () => {
      const deps = buildDeps({
        getTask: vi.fn(() => createTask()),
        updateTask: vi.fn(() => createTask({ priority: 3 }))
      })
      const commands = createTasksCommands(deps)

      await commands.updateTask({ id: 'task-1', priority: 3 })

      expect(deps.repository.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ priority: 3 })
      )
    })

    it('resolves equivalent status on cross-project move', async () => {
      const existing = createTask({ projectId: 'p1', statusId: 'status-p1-todo' })
      const currentStatus = createStatus({ id: 'status-p1-todo', projectId: 'p1' })
      const equivalent = createStatus({ id: 'status-p2-todo', projectId: 'p2' })
      const deps = buildDeps({
        getTask: vi.fn(() => existing),
        getStatus: vi.fn(() => currentStatus),
        getEquivalentStatus: vi.fn(() => equivalent),
        updateTask: vi.fn(() => createTask({ projectId: 'p2', statusId: 'status-p2-todo' }))
      })
      const commands = createTasksCommands(deps)

      await commands.updateTask({ id: 'task-1', projectId: 'p2' })

      expect(deps.repository.getEquivalentStatus).toHaveBeenCalledWith('p2', currentStatus)
      expect(deps.repository.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ statusId: 'status-p2-todo', projectId: 'p2' })
      )
    })

    it('does not touch tags or links when not provided', async () => {
      const deps = buildDeps({
        getTask: vi.fn(() => createTask()),
        updateTask: vi.fn(() => createTask({ title: 'New' }))
      })
      const commands = createTasksCommands(deps)

      await commands.updateTask({ id: 'task-1', title: 'New' })

      expect(deps.repository.setTaskTags).not.toHaveBeenCalled()
      expect(deps.repository.setTaskNotes).not.toHaveBeenCalled()
    })

    it('does not mutate the input object', async () => {
      const deps = buildDeps({
        getTask: vi.fn(() => createTask()),
        updateTask: vi.fn(() => createTask())
      })
      const commands = createTasksCommands(deps)
      const input = { id: 'task-1', title: 'X', tags: ['a'] }
      const snapshot = JSON.stringify(input)

      await commands.updateTask(input)

      expect(JSON.stringify(input)).toBe(snapshot)
    })
  })

  describe('completeTask', () => {
    it('publishes completion and returns task on success', async () => {
      const task = createTask({ completedAt: '2026-04-16T12:00:00.000Z' })
      const deps = buildDeps({ completeTask: vi.fn(() => task) })
      const commands = createTasksCommands(deps)

      const result = await commands.completeTask({ id: 'task-1' })

      expect(result).toEqual({ success: true, task })
      expect(deps.publisher.taskCompleted).toHaveBeenCalledWith({ id: 'task-1', task })
    })

    it('returns error when task missing', async () => {
      const deps = buildDeps()
      const commands = createTasksCommands(deps)

      const result = await commands.completeTask({ id: 'missing' })

      expect(result).toEqual({ success: false, task: null, error: 'Task not found' })
      expect(deps.publisher.taskCompleted).not.toHaveBeenCalled()
    })
  })

  describe('uncompleteTask', () => {
    it('publishes taskUpdated with completedAt=null', async () => {
      const task = createTask({ completedAt: null })
      const deps = buildDeps({ uncompleteTask: vi.fn(() => task) })
      const commands = createTasksCommands(deps)

      await commands.uncompleteTask('task-1')

      expect(deps.publisher.taskUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'task-1',
          task,
          changes: { completedAt: null },
          changedFields: ['completedAt']
        })
      )
    })

    it('returns error when task missing', async () => {
      const deps = buildDeps()
      const commands = createTasksCommands(deps)

      const result = await commands.uncompleteTask('missing')

      expect(result).toEqual({ success: false, task: null, error: 'Task not found' })
    })
  })

  describe('archiveTask / unarchiveTask', () => {
    it('archiveTask publishes archivedAt change', async () => {
      const task = createTask({ archivedAt: '2026-04-16T12:00:00.000Z' })
      const deps = buildDeps({ archiveTask: vi.fn(() => task) })
      const commands = createTasksCommands(deps)

      const result = await commands.archiveTask('task-1')

      expect(result).toEqual({ success: true })
      expect(deps.publisher.taskUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: { archivedAt: task.archivedAt },
          changedFields: ['archivedAt']
        })
      )
    })

    it('archiveTask returns error when missing', async () => {
      const commands = createTasksCommands(buildDeps())
      expect(await commands.archiveTask('m')).toEqual({ success: false, error: 'Task not found' })
    })

    it('unarchiveTask publishes archivedAt=null', async () => {
      const task = createTask({ archivedAt: null })
      const deps = buildDeps({ unarchiveTask: vi.fn(() => task) })
      const commands = createTasksCommands(deps)

      await commands.unarchiveTask('task-1')

      expect(deps.publisher.taskUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ changes: { archivedAt: null } })
      )
    })

    it('unarchiveTask returns error when missing', async () => {
      const commands = createTasksCommands(buildDeps())
      expect(await commands.unarchiveTask('m')).toEqual({
        success: false,
        error: 'Task not found'
      })
    })
  })

  describe('duplicateTask', () => {
    it('duplicates task, copies tags/links, duplicates subtasks, publishes for each', async () => {
      const duplicated = createTask({ id: 'gen-1', title: 'T (copy)' })
      const subtask = createTask({ id: 'sub-1', parentId: 'task-1' })
      const duplicatedSubtask = createTask({ id: 'gen-2', parentId: 'gen-1' })
      const deps = buildDeps({
        duplicateTask: vi.fn(() => duplicated),
        getTaskTags: vi.fn((id) => (id === 'task-1' ? ['x'] : ['y'])),
        getTaskNoteIds: vi.fn((id) => (id === 'task-1' ? ['n1'] : ['n2'])),
        getSubtasks: vi.fn(() => [subtask]),
        duplicateSubtask: vi.fn(() => duplicatedSubtask)
      })
      const commands = createTasksCommands(deps)

      const result = await commands.duplicateTask('task-1')

      expect(result.success).toBe(true)
      expect(result.task?.id).toBe('gen-1')
      expect(deps.repository.setTaskTags).toHaveBeenCalledWith('gen-1', ['x'])
      expect(deps.repository.setTaskNotes).toHaveBeenCalledWith('gen-1', ['n1'])
      expect(deps.repository.duplicateSubtask).toHaveBeenCalledWith('sub-1', 'gen-2', 'gen-1')
      expect(deps.repository.setTaskTags).toHaveBeenCalledWith('gen-2', ['y'])
      expect(deps.publisher.taskCreated).toHaveBeenCalledTimes(2)
    })

    it('returns error when source task missing', async () => {
      const commands = createTasksCommands(buildDeps())
      expect(await commands.duplicateTask('missing')).toEqual({
        success: false,
        task: null,
        error: 'Task not found'
      })
    })

    it('skips subtask duplication failures without throwing', async () => {
      const deps = buildDeps({
        duplicateTask: vi.fn(() => createTask({ id: 'gen-1' })),
        getSubtasks: vi.fn(() => [createTask({ id: 'sub-1' })]),
        duplicateSubtask: vi.fn(() => undefined)
      })
      const commands = createTasksCommands(deps)

      const result = await commands.duplicateTask('task-1')

      expect(result.success).toBe(true)
      expect(deps.publisher.taskCreated).toHaveBeenCalledTimes(1)
    })
  })

  describe('convertToSubtask / convertToTask', () => {
    it('convertToSubtask sets parentId, publishes change', async () => {
      const task = createTask({ parentId: 'parent-1' })
      const deps = buildDeps({ moveTask: vi.fn(() => task) })
      const commands = createTasksCommands(deps)

      await commands.convertToSubtask('task-1', 'parent-1')

      expect(deps.repository.moveTask).toHaveBeenCalledWith('task-1', { parentId: 'parent-1' })
      expect(deps.publisher.taskUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ changes: { parentId: 'parent-1' } })
      )
    })

    it('convertToSubtask returns error when missing', async () => {
      const commands = createTasksCommands(buildDeps())
      expect(await commands.convertToSubtask('m', 'p')).toEqual({
        success: false,
        task: null,
        error: 'Task not found'
      })
    })

    it('convertToTask clears parentId, publishes change', async () => {
      const task = createTask({ parentId: null })
      const deps = buildDeps({ moveTask: vi.fn(() => task) })
      const commands = createTasksCommands(deps)

      await commands.convertToTask('task-1')

      expect(deps.repository.moveTask).toHaveBeenCalledWith('task-1', { parentId: null })
      expect(deps.publisher.taskUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ changes: { parentId: null } })
      )
    })

    it('convertToTask returns error when missing', async () => {
      const commands = createTasksCommands(buildDeps())
      expect(await commands.convertToTask('m')).toEqual({
        success: false,
        task: null,
        error: 'Task not found'
      })
    })
  })

  describe('reorderTasks', () => {
    it('calls taskReordered when publisher provides it', async () => {
      const deps = buildDeps()
      const commands = createTasksCommands(deps)

      await commands.reorderTasks(['a', 'b'], [0, 1])

      expect(deps.repository.reorderTasks).toHaveBeenCalledWith(['a', 'b'], [0, 1])
      expect(deps.publisher.taskReordered).toHaveBeenCalledTimes(2)
      expect(deps.publisher.taskUpdated).not.toHaveBeenCalled()
    })

    it('falls back to taskUpdated when taskReordered is absent', async () => {
      const task = createTask({ position: 5 })
      const repository = createCommandRepository({ getTask: vi.fn(() => task) })
      const publisher = createPublisher()
      delete (publisher as Partial<typeof publisher>).taskReordered
      const commands = createTasksCommands({
        repository,
        publisher,
        generateId: vi.fn(() => 'gen')
      })

      await commands.reorderTasks(['task-1'], [5])

      expect(publisher.taskUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ changedFields: ['position'] })
      )
    })

    it('skips missing tasks in fallback path', async () => {
      const repository = createCommandRepository({ getTask: vi.fn(() => undefined) })
      const publisher = createPublisher()
      delete (publisher as Partial<typeof publisher>).taskReordered
      const commands = createTasksCommands({
        repository,
        publisher,
        generateId: vi.fn(() => 'gen')
      })

      await commands.reorderTasks(['task-1'], [0])

      expect(publisher.taskUpdated).not.toHaveBeenCalled()
    })
  })

  describe('bulk operations', () => {
    it('bulkComplete publishes taskCompleted for each found task', async () => {
      const task = createTask()
      const deps = buildDeps({
        bulkCompleteTasks: vi.fn(() => 2),
        getTask: vi.fn(() => task)
      })
      const commands = createTasksCommands(deps)

      const result = await commands.bulkComplete(['a', 'b'])

      expect(result).toEqual({ success: true, count: 2 })
      expect(deps.publisher.taskCompleted).toHaveBeenCalledTimes(2)
    })

    it('bulkDelete snapshots each id and publishes deletion', async () => {
      const task = createTask()
      const deps = buildDeps({
        getTask: vi.fn(() => task),
        bulkDeleteTasks: vi.fn(() => 2)
      })
      const commands = createTasksCommands(deps)

      await commands.bulkDelete(['a', 'b'])

      expect(deps.publisher.taskDeleted).toHaveBeenCalledTimes(2)
      expect(deps.publisher.taskDeleted).toHaveBeenCalledWith({ id: 'a', snapshot: task })
    })

    it('bulkMove publishes taskUpdated with projectId change', async () => {
      const task = createTask()
      const deps = buildDeps({
        bulkMoveTasks: vi.fn(() => 1),
        getTask: vi.fn(() => task)
      })
      const commands = createTasksCommands(deps)

      await commands.bulkMove(['a'], 'p2')

      expect(deps.publisher.taskUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: { projectId: 'p2' },
          changedFields: ['projectId', 'position']
        })
      )
    })

    it('bulkArchive publishes archivedAt change', async () => {
      const task = createTask({ archivedAt: '2026-04-16T12:00:00.000Z' })
      const deps = buildDeps({
        bulkArchiveTasks: vi.fn(() => 1),
        getTask: vi.fn(() => task)
      })
      const commands = createTasksCommands(deps)

      await commands.bulkArchive(['a'])

      expect(deps.publisher.taskUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ changedFields: ['archivedAt'] })
      )
    })

    it('bulk operations silently skip ids that no longer exist', async () => {
      const deps = buildDeps({
        bulkCompleteTasks: vi.fn(() => 0),
        getTask: vi.fn(() => undefined)
      })
      const commands = createTasksCommands(deps)

      await commands.bulkComplete(['missing'])

      expect(deps.publisher.taskCompleted).not.toHaveBeenCalled()
    })
  })

  describe('project commands', () => {
    it('updateProject updates metadata, reconciles statuses, publishes', async () => {
      const project = createProjectWithStatuses({ name: 'Updated' })
      const deps = buildDeps({
        updateProject: vi.fn(() => project),
        getProject: vi.fn(() => project)
      })
      const commands = createTasksCommands(deps)

      const result = await commands.updateProject({
        id: 'project-1',
        name: 'Updated',
        statuses: [
          { name: 'A', color: '#111', type: 'todo', order: 0 },
          { name: 'B', color: '#222', type: 'done', order: 1 }
        ]
      })

      expect(result.success).toBe(true)
      expect(deps.repository.reconcileProjectStatuses).toHaveBeenCalled()
      const call = vi.mocked(deps.publisher.projectUpdated).mock.calls[0][0]
      expect(call.changedFields).toEqual(expect.arrayContaining(['name', 'statuses']))
    })

    it('updateProject returns error when project missing', async () => {
      const commands = createTasksCommands(buildDeps())
      expect(await commands.updateProject({ id: 'm', name: 'x' })).toEqual({
        success: false,
        project: null,
        error: 'Project not found'
      })
    })

    it('updateProject throws when project cannot be reloaded', async () => {
      const existing = createProjectWithStatuses()
      const deps = buildDeps({
        updateProject: vi.fn(() => existing),
        getProject: vi.fn(() => undefined)
      })
      const commands = createTasksCommands(deps)

      await expect(commands.updateProject({ id: 'project-1', name: 'X' })).rejects.toThrow(
        'Project not found after update'
      )
    })

    it('deleteProject snapshots and publishes deletion', async () => {
      const snapshot = createProjectWithStatuses()
      const deps = buildDeps({ getProject: vi.fn(() => snapshot) })
      const commands = createTasksCommands(deps)

      await commands.deleteProject('project-1')

      expect(deps.repository.deleteProject).toHaveBeenCalledWith('project-1')
      expect(deps.publisher.projectDeleted).toHaveBeenCalledWith({
        id: 'project-1',
        snapshot
      })
    })

    it('archiveProject publishes archivedAt change and returns success', async () => {
      const archived = createProjectWithStatuses({
        archivedAt: '2026-04-16T12:00:00.000Z'
      })
      const deps = buildDeps({
        archiveProject: vi.fn(() => archived),
        getProject: vi.fn(() => archived)
      })
      const commands = createTasksCommands(deps)

      const result = await commands.archiveProject('project-1')

      expect(result).toEqual({ success: true })
      expect(deps.publisher.projectUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ changedFields: ['archivedAt'] })
      )
    })

    it('archiveProject returns error when project missing', async () => {
      const commands = createTasksCommands(buildDeps())
      expect(await commands.archiveProject('m')).toEqual({
        success: false,
        error: 'Project not found'
      })
    })

    it('archiveProject uses repository result when getProject returns nothing', async () => {
      const archived = createProjectWithStatuses({ archivedAt: 'then' })
      const deps = buildDeps({
        archiveProject: vi.fn(() => archived),
        getProject: vi.fn(() => undefined)
      })
      const commands = createTasksCommands(deps)

      await commands.archiveProject('project-1')

      expect(deps.publisher.projectUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ project: archived })
      )
    })

    it('reorderProjects publishes per-project updates with position change', async () => {
      const project = createProjectWithStatuses()
      const deps = buildDeps({ getProject: vi.fn(() => project) })
      const commands = createTasksCommands(deps)

      await commands.reorderProjects(['p1', 'p2'], [0, 1])

      expect(deps.repository.reorderProjects).toHaveBeenCalledWith(['p1', 'p2'], [0, 1])
      expect(deps.publisher.projectUpdated).toHaveBeenCalledTimes(2)
    })

    it('reorderProjects skips missing projects', async () => {
      const deps = buildDeps({ getProject: vi.fn(() => undefined) })
      const commands = createTasksCommands(deps)

      await commands.reorderProjects(['p1'], [0])

      expect(deps.publisher.projectUpdated).not.toHaveBeenCalled()
    })
  })

  describe('status commands', () => {
    it('updateStatus publishes refreshed status', async () => {
      const status = createStatus({ name: 'Updated' })
      const deps = buildDeps({
        updateStatus: vi.fn(() => status),
        getStatus: vi.fn(() => status)
      })
      const commands = createTasksCommands(deps)

      const result = await commands.updateStatus({ id: 'status-1', name: 'Updated' })

      expect(result).toEqual({ success: true, status })
      expect(deps.publisher.statusUpdated).toHaveBeenCalledWith({ status })
    })

    it('updateStatus falls back to returned status if reload misses', async () => {
      const status = createStatus()
      const deps = buildDeps({
        updateStatus: vi.fn(() => status),
        getStatus: vi.fn(() => undefined)
      })
      const commands = createTasksCommands(deps)

      const result = await commands.updateStatus({ id: 'status-1', name: 'x' })

      expect(result.status).toBe(status)
    })

    it('updateStatus returns error when not found', async () => {
      const commands = createTasksCommands(buildDeps())
      expect(await commands.updateStatus({ id: 'm', name: 'x' })).toEqual({
        success: false,
        error: 'Status not found'
      })
    })

    it('deleteStatus publishes statusDeleted with projectId when found', async () => {
      const status = createStatus({ projectId: 'p1' })
      const deps = buildDeps({ getStatus: vi.fn(() => status) })
      const commands = createTasksCommands(deps)

      await commands.deleteStatus('status-1')

      expect(deps.publisher.statusDeleted).toHaveBeenCalledWith({
        id: 'status-1',
        projectId: 'p1'
      })
    })

    it('deleteStatus skips publish when status not found', async () => {
      const deps = buildDeps()
      const commands = createTasksCommands(deps)

      await commands.deleteStatus('missing')

      expect(deps.publisher.statusDeleted).not.toHaveBeenCalled()
      expect(deps.repository.deleteStatus).toHaveBeenCalledWith('missing')
    })

    it('reorderStatuses publishes statusUpdated per found status', async () => {
      const status = createStatus()
      const deps = buildDeps({ getStatus: vi.fn(() => status) })
      const commands = createTasksCommands(deps)

      await commands.reorderStatuses(['s1', 's2'], [0, 1])

      expect(deps.repository.reorderStatuses).toHaveBeenCalledWith(['s1', 's2'], [0, 1])
      expect(deps.publisher.statusUpdated).toHaveBeenCalledTimes(2)
    })

    it('reorderStatuses skips missing statuses', async () => {
      const deps = buildDeps({ getStatus: vi.fn(() => undefined) })
      const commands = createTasksCommands(deps)

      await commands.reorderStatuses(['s1'], [0])

      expect(deps.publisher.statusUpdated).not.toHaveBeenCalled()
    })
  })
})
