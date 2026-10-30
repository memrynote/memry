import type { Task } from './types.ts'
import type {
  TaskCreateInput,
  TaskUpdateInput,
  TaskMoveInput,
  TaskCompleteInput,
  TasksCommandRepository,
  TasksDomainPublisher,
  TasksDomainEvent,
  TasksWrite,
  TasksUnitOfWork,
  CreateTasksCommandsDeps
} from './commands-types.ts'
import { createProjectCommands } from './commands-projects.ts'
import { completedAtOnStatus, doneStatusIdOnComplete, openStatusIdOnReopen } from './completion.ts'
import { checkParent, type ParentLookup } from './tree.ts'

const AUTOCOMMIT_UNIT_OF_WORK: TasksUnitOfWork = {
  run: (write) => write()
}

function publishTasksEvent(
  publisher: TasksDomainPublisher,
  event: TasksDomainEvent
): void | Promise<void> {
  switch (event.kind) {
    case 'taskCreated':
      return publisher.taskCreated(event.payload)
    case 'taskUpdated':
      return publisher.taskUpdated(event.payload)
    case 'taskDeleted':
      return publisher.taskDeleted(event.payload)
    case 'taskCompleted':
      return publisher.taskCompleted(event.payload)
    case 'taskMoved':
      return publisher.taskMoved(event.payload)
    case 'taskReordered':
      return publisher.taskReordered?.(event.payload)
    case 'projectCreated':
      return publisher.projectCreated(event.payload)
    case 'projectUpdated':
      return publisher.projectUpdated(event.payload)
    case 'projectDeleted':
      return publisher.projectDeleted(event.payload)
    case 'statusCreated':
      return publisher.statusCreated(event.payload)
    case 'statusUpdated':
      return publisher.statusUpdated(event.payload)
    case 'statusDeleted':
      return publisher.statusDeleted(event.payload)
  }
}

/**
 * Drops keys whose value is `undefined`.
 *
 * Callers do not send only what the user touched. The tasks page builds one
 * fixed key set on every edit — title, description, priority, projectId,
 * statusId, dueDate, dueTime, isRepeating, repeatConfig, tags, linkedNoteIds —
 * and leaves the untouched ones `undefined`, so the raw input says nothing
 * about what changed. The write layer already ignores them (drizzle omits
 * `undefined` from `.set()`), so treating them as changes only misreports: a
 * status-only edit would log every other field as cleared in the activity feed
 * and bump the sync field clock of each, letting this device win a merge on
 * fields it never edited.
 *
 * `null` is untouched — it still means "clear this field".
 */
function definedUpdates(updates: Partial<Task>): Partial<Task> {
  return Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined))
}

function computeChangedFields(
  existingTask: Task | undefined,
  updates: Partial<Task>,
  relationChanges: Array<{ field: keyof Task; before: unknown; after: unknown }> = []
): string[] {
  const changedFields = new Set<string>()

  if (!existingTask) {
    for (const key of Object.keys(updates)) {
      changedFields.add(key)
    }
  } else {
    const existingFields: Record<string, unknown> = { ...existingTask }
    for (const [key, value] of Object.entries(updates)) {
      const previous = existingFields[key] ?? null
      const next = value ?? null
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        changedFields.add(key)
      }
    }
  }

  for (const relationChange of relationChanges) {
    if (JSON.stringify(relationChange.before) !== JSON.stringify(relationChange.after)) {
      changedFields.add(relationChange.field)
    }
  }

  return [...changedFields]
}

/**
 * The pre-write value of each field `computeChangedFields` reported as changed.
 *
 * Not a second differ — it reads the field list the differ already produced and
 * projects the old row through it, so the two can never disagree about what
 * changed.
 */
function pickPrevious(
  existingTask: Task | undefined,
  changedFields: string[],
  overrides: Partial<Task> = {}
): Partial<Task> {
  const previous: Partial<Task> = {}
  if (existingTask) {
    const existingFields: Record<string, unknown> = { ...existingTask }
    for (const field of changedFields) {
      if (field in existingTask) {
        ;(previous as Record<string, unknown>)[field] = existingFields[field]
      }
    }
  }
  return { ...previous, ...overrides }
}

function mergeTaskRelations(
  task: Task,
  relations: Partial<Pick<Task, 'tags' | 'linkedNoteIds' | 'linkedCanvasIds'>>
): Task {
  return {
    ...task,
    ...(relations.tags !== undefined ? { tags: relations.tags } : {}),
    ...(relations.linkedNoteIds !== undefined ? { linkedNoteIds: relations.linkedNoteIds } : {}),
    ...(relations.linkedCanvasIds !== undefined
      ? { linkedCanvasIds: relations.linkedCanvasIds }
      : {})
  }
}

/**
 * `tasks.status_id` is FK-bound with ON DELETE SET NULL, so null IS the
 * schema's own answer for a status that no longer exists. A project sync
 * reconciles statuses away underneath renderer caches that still hold the old
 * id, and the next edit echoes that dead id back into the write. Drop the
 * dangling reference rather than failing the edit on a raw constraint.
 *
 * `undefined` means "not part of this edit" and must survive as `undefined`,
 * because definedUpdates() strips it and drizzle omits it from `.set()`.
 *
 * The sync path already does this in main/sync/item-handlers/task-handler.ts;
 * only the local write was unguarded, which is why the constraint fired here.
 */
function resolveStatusId<T extends string | null | undefined>(
  repository: TasksCommandRepository,
  statusId: T
): T | null {
  if (statusId === undefined || statusId === null) return statusId
  return repository.getStatus(statusId) ? statusId : null
}

/**
 * `tasks.project_id` is NOT NULL and FK-bound, so an absent project makes the
 * row unwritable. Report it as a real message instead of SQLite's anonymous
 * `FOREIGN KEY constraint failed`.
 */
function projectIsMissing(
  repository: TasksCommandRepository,
  projectId: string | undefined
): boolean {
  return projectId !== undefined && !repository.getProject(projectId)
}

const PROJECT_MISSING_ERROR = 'errors:task.projectMissing'
const INVALID_PARENT_ERROR = 'errors:task.invalidParent'

function repositoryParentLookup(repository: TasksCommandRepository): ParentLookup {
  return {
    get: (id) => repository.getTask(id),
    hasChildren: (id) => repository.getSubtasks(id).length > 0
  }
}

export function createTasksCommands({
  repository,
  publisher,
  generateId,
  unitOfWork = AUTOCOMMIT_UNIT_OF_WORK,
  onPublisherError,
  allowNestedSubtasks
}: CreateTasksCommandsDeps) {
  const parentLookup = repositoryParentLookup(repository)
  /** True when `parentId` is a place `taskId` may not go. Null/undefined parents always pass. */
  function rejectsParent(
    taskId: string | null,
    parentId: string | null | undefined,
    projectId: string | undefined
  ): boolean {
    if (parentId === null || parentId === undefined || projectId === undefined) return false
    return (
      checkParent(parentLookup, taskId, parentId, projectId, allowNestedSubtasks?.() ?? false) !==
      null
    )
  }

  // The write phase commits before any publisher code runs: the publisher is
  // async and does I/O, which a synchronous storage transaction cannot span.
  async function commit<W extends TasksWrite<unknown>>(write: () => W): Promise<W['result']> {
    const { result, events } = unitOfWork.run(write)
    for (const event of events) {
      try {
        await publishTasksEvent(publisher, event)
      } catch (error) {
        onPublisherError?.(event.kind, error)
      }
    }
    return result
  }

  return {
    async createTask(input: TaskCreateInput) {
      return commit(() => {
        if (projectIsMissing(repository, input.projectId)) {
          return {
            result: { success: false as const, task: null, error: PROJECT_MISSING_ERROR },
            events: []
          }
        }

        if (rejectsParent(null, input.parentId, input.projectId)) {
          return {
            result: { success: false as const, task: null, error: INVALID_PARENT_ERROR },
            events: []
          }
        }

        const id = generateId()
        const position =
          input.position ?? repository.getNextTaskPosition(input.projectId, input.parentId)

        const createdTask = repository.createTask({
          id,
          projectId: input.projectId,
          statusId: resolveStatusId(repository, input.statusId ?? null),
          parentId: input.parentId ?? null,
          title: input.title,
          description: input.description ?? null,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- contract priority is a validated number; Task narrows it to the 0-4 union
          priority: (input.priority ?? 0) as Task['priority'],
          position,
          dueDate: input.dueDate ?? null,
          dueTime: input.dueTime ?? null,
          durationMinutes: input.dueTime ? (input.durationMinutes ?? null) : null,
          startDate: input.startDate ?? null,
          repeatConfig: input.repeatConfig ?? null,
          repeatFrom: input.repeatFrom ?? null,
          sourceNoteId: input.sourceNoteId ?? null,
          completedAt: null,
          archivedAt: null,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          ...(input.fields ? { fields: input.fields } : {})
        })

        if (input.tags && input.tags.length > 0) {
          repository.setTaskTags(id, input.tags)
        }

        if (input.linkedNoteIds && input.linkedNoteIds.length > 0) {
          repository.setTaskNotes(id, input.linkedNoteIds)
        }

        if (input.linkedCanvasIds && input.linkedCanvasIds.length > 0) {
          repository.setTaskCanvases(id, input.linkedCanvasIds)
        }

        const task = mergeTaskRelations(createdTask, {
          tags: input.tags ?? createdTask.tags,
          linkedNoteIds: input.linkedNoteIds ?? createdTask.linkedNoteIds,
          linkedCanvasIds: input.linkedCanvasIds ?? createdTask.linkedCanvasIds
        })
        const events: TasksDomainEvent[] = [{ kind: 'taskCreated', payload: { task } }]
        return { result: { success: true, task }, events }
      })
    },

    async updateTask(input: TaskUpdateInput) {
      return commit(() => {
        const { id, tags, linkedNoteIds, linkedCanvasIds, priority, fields, ...rawUpdates } = input
        const existingTask = repository.getTask(id)

        const updates: Partial<Task> = definedUpdates({
          ...rawUpdates,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- contract priority is a validated number; Task narrows it to the 0-4 union
          ...(priority !== undefined ? { priority: priority as Task['priority'] } : {})
        })

        // A duration only means something on a timed task.
        if (updates.dueTime === null) {
          updates.durationMinutes = null
        }

        if (projectIsMissing(repository, updates.projectId)) {
          return {
            result: { success: false as const, task: null, error: PROJECT_MISSING_ERROR },
            events: []
          }
        }

        if (rejectsParent(id, updates.parentId, updates.projectId ?? existingTask?.projectId)) {
          return {
            result: { success: false as const, task: null, error: INVALID_PARENT_ERROR },
            events: []
          }
        }

        if (updates.projectId && existingTask && existingTask.projectId !== updates.projectId) {
          const currentStatus = existingTask.statusId
            ? repository.getStatus(existingTask.statusId)
            : undefined
          const equivalentStatus = repository.getEquivalentStatus(updates.projectId, currentStatus)
          if (equivalentStatus) {
            updates.statusId = equivalentStatus.id
          }
        }

        // Guarded: a bare assignment would re-add a `statusId: undefined` key that
        // definedUpdates() just stripped, and computeChangedFields() would then
        // report a cleared status on every edit that never touched it.
        if (updates.statusId !== undefined) {
          updates.statusId = resolveStatusId(repository, updates.statusId)
          const status = updates.statusId ? repository.getStatus(updates.statusId) : undefined
          const completedAt = completedAtOnStatus(existingTask, status, new Date().toISOString())
          if (completedAt !== undefined) updates.completedAt = completedAt
        }

        const oldTags = tags !== undefined ? repository.getTaskTags(id) : undefined
        const oldNoteIds = linkedNoteIds !== undefined ? repository.getTaskNoteIds(id) : undefined
        const oldCanvasIds =
          linkedCanvasIds !== undefined ? repository.getTaskCanvasIds(id) : undefined

        const task = repository.updateTask(id, updates)
        if (!task) {
          return { result: { success: false, task: null, error: 'Task not found' }, events: [] }
        }

        if (tags !== undefined) {
          repository.setTaskTags(id, tags)
        }

        if (linkedNoteIds !== undefined) {
          repository.setTaskNotes(id, linkedNoteIds)
        }

        if (linkedCanvasIds !== undefined) {
          repository.setTaskCanvases(id, linkedCanvasIds)
        }

        const fieldsPatch =
          fields !== undefined ? repository.patchTaskFields(id, fields) : undefined

        const resolvedTask: Task = {
          ...task,
          ...(tags !== undefined ? { tags } : {}),
          ...(linkedNoteIds !== undefined ? { linkedNoteIds } : {}),
          ...(linkedCanvasIds !== undefined ? { linkedCanvasIds } : {}),
          ...(fieldsPatch ? { fields: fieldsPatch.after } : {})
        }
        const changedFields = computeChangedFields(existingTask, updates, [
          {
            field: 'tags',
            before: oldTags,
            after: tags
          },
          {
            field: 'linkedNoteIds',
            before: oldNoteIds,
            after: linkedNoteIds
          },
          {
            field: 'linkedCanvasIds',
            before: oldCanvasIds,
            after: linkedCanvasIds
          },
          {
            field: 'fields',
            before: fieldsPatch?.before,
            after: fieldsPatch?.after
          }
        ])

        const changes: Partial<Task> = {
          ...updates,
          ...(tags !== undefined ? { tags } : {}),
          ...(linkedNoteIds !== undefined ? { linkedNoteIds } : {}),
          ...(linkedCanvasIds !== undefined ? { linkedCanvasIds } : {}),
          ...(fieldsPatch ? { fields: fieldsPatch.after } : {})
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskUpdated',
            payload: {
              id,
              task: resolvedTask,
              changes,
              changedFields,
              // Relations live in their own tables, so `existingTask.tags` is not the
              // pre-write truth — the explicit reads above are.
              previous: pickPrevious(existingTask, changedFields, {
                ...(oldTags !== undefined ? { tags: oldTags } : {}),
                ...(oldNoteIds !== undefined ? { linkedNoteIds: oldNoteIds } : {}),
                ...(oldCanvasIds !== undefined ? { linkedCanvasIds: oldCanvasIds } : {}),
                ...(fieldsPatch ? { fields: fieldsPatch.before } : {})
              })
            }
          }
        ]
        return { result: { success: true, task: resolvedTask }, events }
      })
    },

    async deleteTask(id: string) {
      return commit(() => {
        // Subtasks go with their parent so none keeps a parent_id that points at
        // a deleted row. A caller that wants to keep them moves them out first.
        // Each row gets its own tombstone; sync cannot see a cascade (#2854).
        const branch: string[] = []
        const seen = new Set([id])
        for (let i = -1; i < branch.length; i++) {
          for (const child of repository.getSubtasks(i < 0 ? id : branch[i])) {
            if (seen.has(child.id)) continue
            seen.add(child.id)
            branch.push(child.id)
          }
        }
        const events: TasksDomainEvent[] = []
        // Deepest first, parent last.
        for (const taskId of [...branch.toReversed(), id]) {
          const snapshot = repository.getTask(taskId)
          repository.deleteTask(taskId)
          events.push({ kind: 'taskDeleted', payload: { id: taskId, snapshot } })
        }
        return { result: { success: true }, events }
      })
    },

    async completeTask(input: TaskCompleteInput) {
      return commit(() => {
        // Pre-read: completeTask writes before it returns, so by the time we have
        // `task` the old completedAt is already gone.
        const before = repository.getTask(input.id)
        const completed = repository.completeTask(input.id, input.completedAt)
        if (!completed) {
          return { result: { success: false, task: null, error: 'Task not found' }, events: [] }
        }
        // Completion also puts the task in its project's done status.
        const doneStatusId = doneStatusIdOnComplete(repository, before)
        const task = doneStatusId
          ? (repository.updateTask(input.id, { statusId: doneStatusId }) ?? completed)
          : completed

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskCompleted',
            payload: {
              id: input.id,
              task,
              previous: {
                completedAt: before?.completedAt ?? null,
                ...(doneStatusId ? { statusId: before?.statusId ?? null } : {})
              }
            }
          }
        ]
        return { result: { success: true, task }, events }
      })
    },

    async uncompleteTask(id: string) {
      return commit(() => {
        const before = repository.getTask(id)
        const reopened = repository.uncompleteTask(id)
        if (!reopened) {
          return { result: { success: false, task: null, error: 'Task not found' }, events: [] }
        }
        // Reopening also takes the task out of its project's done status.
        const openStatusId = openStatusIdOnReopen(repository, before)
        const task = openStatusId
          ? (repository.updateTask(id, { statusId: openStatusId }) ?? reopened)
          : reopened
        const changedFields = openStatusId ? ['completedAt', 'statusId'] : ['completedAt']

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskUpdated',
            payload: {
              id,
              task,
              changes: { completedAt: null, ...(openStatusId ? { statusId: openStatusId } : {}) },
              changedFields,
              previous: pickPrevious(before, changedFields)
            }
          }
        ]
        return { result: { success: true, task }, events }
      })
    },

    async archiveTask(id: string) {
      return commit(() => {
        const before = repository.getTask(id)
        const task = repository.archiveTask(id)
        if (!task) {
          return { result: { success: false, error: 'Task not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskUpdated',
            payload: {
              id,
              task,
              changes: { archivedAt: task.archivedAt },
              changedFields: ['archivedAt'],
              previous: { archivedAt: before?.archivedAt ?? null }
            }
          }
        ]
        return { result: { success: true }, events }
      })
    },

    async unarchiveTask(id: string) {
      return commit(() => {
        const before = repository.getTask(id)
        const task = repository.unarchiveTask(id)
        if (!task) {
          return { result: { success: false, error: 'Task not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskUpdated',
            payload: {
              id,
              task,
              changes: { archivedAt: null },
              changedFields: ['archivedAt'],
              previous: { archivedAt: before?.archivedAt ?? null }
            }
          }
        ]
        return { result: { success: true }, events }
      })
    },

    async moveTask(input: TaskMoveInput) {
      return commit(() => {
        if (projectIsMissing(repository, input.targetProjectId)) {
          return {
            result: { success: false as const, task: null, error: PROJECT_MISSING_ERROR },
            events: []
          }
        }

        const before = repository.getTask(input.taskId)
        if (
          rejectsParent(
            input.taskId,
            input.targetParentId,
            input.targetProjectId ?? before?.projectId
          )
        ) {
          return {
            result: { success: false as const, task: null, error: INVALID_PARENT_ERROR },
            events: []
          }
        }
        let targetStatusId = input.targetStatusId
        if (input.targetProjectId && !targetStatusId) {
          const currentTask = before
          if (currentTask && currentTask.projectId !== input.targetProjectId) {
            const currentStatus = currentTask.statusId
              ? repository.getStatus(currentTask.statusId)
              : undefined
            const equivalentStatus = repository.getEquivalentStatus(
              input.targetProjectId,
              currentStatus
            )
            if (equivalentStatus) {
              targetStatusId = equivalentStatus.id
            }
          }
        }

        let task = repository.moveTask(input.taskId, {
          projectId: input.targetProjectId,
          statusId: resolveStatusId(repository, targetStatusId),
          parentId: input.targetParentId,
          position: input.position
        })

        if (!task) {
          return { result: { success: false, task: null, error: 'Task not found' }, events: [] }
        }

        const changedFields = ['position']
        if (input.targetProjectId) changedFields.push('projectId')
        if (targetStatusId !== undefined) changedFields.push('statusId')
        // A card dropped into a done column is complete, and out of it reopened.
        const status = targetStatusId ? repository.getStatus(targetStatusId) : undefined
        const completedAt = completedAtOnStatus(before, status, new Date().toISOString())
        if (completedAt !== undefined) {
          task = repository.updateTask(input.taskId, { completedAt }) ?? task
          changedFields.push('completedAt')
        }
        if (input.targetParentId !== undefined) changedFields.push('parentId')

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskMoved',
            payload: {
              id: input.taskId,
              task,
              changedFields,
              previous: pickPrevious(before, changedFields)
            }
          }
        ]
        return { result: { success: true, task }, events }
      })
    },

    async reorderTasks(taskIds: string[], positions: number[]) {
      return commit(() => {
        repository.reorderTasks(taskIds, positions)

        const events: TasksDomainEvent[] = []
        for (const taskId of taskIds) {
          if (publisher.taskReordered) {
            events.push({
              kind: 'taskReordered',
              payload: { id: taskId, changedFields: ['position'] }
            })
            continue
          }

          const task = repository.getTask(taskId)
          if (!task) {
            continue
          }

          events.push({
            kind: 'taskUpdated',
            payload: {
              id: taskId,
              task,
              changes: { position: task.position },
              changedFields: ['position']
            }
          })
        }

        return { result: { success: true }, events }
      })
    },

    async duplicateTask(id: string) {
      return commit(() => {
        const newId = generateId()
        const duplicatedTask = repository.duplicateTask(id, newId)
        if (!duplicatedTask) {
          return { result: { success: false, task: null, error: 'Task not found' }, events: [] }
        }

        const tags = repository.getTaskTags(id)
        if (tags.length > 0) {
          repository.setTaskTags(newId, tags)
        }

        const linkedNoteIds = repository.getTaskNoteIds(id)
        if (linkedNoteIds.length > 0) {
          repository.setTaskNotes(newId, linkedNoteIds)
        }

        const linkedCanvasIds = repository.getTaskCanvasIds(id)
        if (linkedCanvasIds.length > 0) {
          repository.setTaskCanvases(newId, linkedCanvasIds)
        }

        const resolvedTask = mergeTaskRelations(duplicatedTask, {
          tags: tags.length > 0 ? tags : duplicatedTask.tags,
          linkedNoteIds: linkedNoteIds.length > 0 ? linkedNoteIds : duplicatedTask.linkedNoteIds,
          linkedCanvasIds:
            linkedCanvasIds.length > 0 ? linkedCanvasIds : duplicatedTask.linkedCanvasIds
        })
        const events: TasksDomainEvent[] = [
          { kind: 'taskCreated', payload: { task: resolvedTask } }
        ]

        const subtasks = repository.getSubtasks(id)
        for (const subtask of subtasks) {
          const newSubtaskId = generateId()
          const duplicatedSubtask = repository.duplicateSubtask(subtask.id, newSubtaskId, newId)
          if (!duplicatedSubtask) continue

          const subtaskTags = repository.getTaskTags(subtask.id)
          if (subtaskTags.length > 0) {
            repository.setTaskTags(newSubtaskId, subtaskTags)
          }

          const subtaskNoteIds = repository.getTaskNoteIds(subtask.id)
          if (subtaskNoteIds.length > 0) {
            repository.setTaskNotes(newSubtaskId, subtaskNoteIds)
          }

          const subtaskCanvasIds = repository.getTaskCanvasIds(subtask.id)
          if (subtaskCanvasIds.length > 0) {
            repository.setTaskCanvases(newSubtaskId, subtaskCanvasIds)
          }

          const resolvedSubtask = mergeTaskRelations(duplicatedSubtask, {
            tags: subtaskTags.length > 0 ? subtaskTags : duplicatedSubtask.tags,
            linkedNoteIds:
              subtaskNoteIds.length > 0 ? subtaskNoteIds : duplicatedSubtask.linkedNoteIds,
            linkedCanvasIds:
              subtaskCanvasIds.length > 0 ? subtaskCanvasIds : duplicatedSubtask.linkedCanvasIds
          })
          events.push({ kind: 'taskCreated', payload: { task: resolvedSubtask } })
        }

        return { result: { success: true, task: resolvedTask }, events }
      })
    },

    async convertToSubtask(taskId: string, parentId: string) {
      return commit(() => {
        const before = repository.getTask(taskId)
        if (rejectsParent(taskId, parentId, before?.projectId)) {
          return {
            result: { success: false as const, task: null, error: INVALID_PARENT_ERROR },
            events: []
          }
        }
        const task = repository.moveTask(taskId, { parentId })
        if (!task) {
          return { result: { success: false, task: null, error: 'Task not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskUpdated',
            payload: {
              id: taskId,
              task,
              changes: { parentId },
              changedFields: ['parentId'],
              previous: { parentId: before?.parentId ?? null }
            }
          }
        ]
        return { result: { success: true, task }, events }
      })
    },

    async convertToTask(taskId: string) {
      return commit(() => {
        const before = repository.getTask(taskId)
        const task = repository.moveTask(taskId, { parentId: null })
        if (!task) {
          return { result: { success: false, task: null, error: 'Task not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskUpdated',
            payload: {
              id: taskId,
              task,
              changes: { parentId: null },
              changedFields: ['parentId'],
              previous: { parentId: before?.parentId ?? null }
            }
          }
        ]
        return { result: { success: true, task }, events }
      })
    },

    ...createProjectCommands({ repository, generateId, commit }),

    async bulkComplete(ids: string[]) {
      return commit(() => {
        // The bulk write is a single `UPDATE … WHERE id IN (…)`, so per-row
        // before-state costs one extra read per id. Accepted: the loop below
        // already reads each row once, and selections are user-sized.
        const before = new Map(ids.map((id) => [id, repository.getTask(id)]))
        const count = repository.bulkCompleteTasks(ids)
        const events: TasksDomainEvent[] = []
        for (const id of ids) {
          const prior = before.get(id)
          const doneStatusId = doneStatusIdOnComplete(repository, prior)
          if (doneStatusId) repository.updateTask(id, { statusId: doneStatusId })
          const task = repository.getTask(id)
          if (task) {
            events.push({
              kind: 'taskCompleted',
              payload: {
                id,
                task,
                previous: {
                  completedAt: prior?.completedAt ?? null,
                  ...(doneStatusId ? { statusId: prior?.statusId ?? null } : {})
                }
              }
            })
          }
        }
        return { result: { success: true, count }, events }
      })
    },

    async bulkDelete(ids: string[]) {
      return commit(() => {
        const snapshots = ids.map((id) => repository.getTask(id))
        const count = repository.bulkDeleteTasks(ids)
        const events = ids.map((id, index): TasksDomainEvent => ({
          kind: 'taskDeleted',
          payload: { id, snapshot: snapshots[index] }
        }))
        return { result: { success: true, count }, events }
      })
    },

    async bulkMove(ids: string[], projectId: string) {
      return commit(() => {
        const before = new Map(ids.map((id) => [id, repository.getTask(id)]))
        const count = repository.bulkMoveTasks(ids, projectId)
        const events: TasksDomainEvent[] = []
        for (const id of ids) {
          const task = repository.getTask(id)
          if (task) {
            events.push({
              kind: 'taskUpdated',
              payload: {
                id,
                task,
                changes: { projectId },
                changedFields: ['projectId', 'position'],
                previous: pickPrevious(before.get(id), ['projectId', 'position'])
              }
            })
          }
        }
        return { result: { success: true, count }, events }
      })
    },

    async bulkArchive(ids: string[]) {
      return commit(() => {
        const before = new Map(ids.map((id) => [id, repository.getTask(id)]))
        const count = repository.bulkArchiveTasks(ids)
        const events: TasksDomainEvent[] = []
        for (const id of ids) {
          const task = repository.getTask(id)
          if (task) {
            events.push({
              kind: 'taskUpdated',
              payload: {
                id,
                task,
                changes: { archivedAt: task.archivedAt },
                changedFields: ['archivedAt'],
                previous: { archivedAt: before.get(id)?.archivedAt ?? null }
              }
            })
          }
        }
        return { result: { success: true, count }, events }
      })
    }
  }
}
