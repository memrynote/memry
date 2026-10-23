import type {
  CreateTasksCommandsDeps,
  ProjectCreateInput,
  ProjectUpdateInput,
  StatusCreateInput,
  StatusUpdateInput,
  TasksCommandRepository,
  TasksCommit,
  TasksDomainEvent
} from './commands-types.ts'
import type {
  ProjectLinkItemInput,
  ProjectSetHomeNoteInput,
  ProjectSetLinkPinnedInput
} from './types.ts'

/** Project, project-link and status commands. Task commands stay in commands.ts. */
export function createProjectCommands({
  repository,
  generateId,
  commit
}: Pick<CreateTasksCommandsDeps, 'generateId'> & {
  repository: TasksCommandRepository
  commit: TasksCommit
}) {
  return {
    async createProject(input: ProjectCreateInput) {
      return commit(() => {
        const id = generateId()
        const position = repository.getNextProjectPosition()

        repository.createProject({
          id,
          name: input.name,
          description: input.description ?? null,
          color: input.color ?? '#6366f1',
          icon: input.icon ?? null,
          position,
          isInbox: false
        })

        if (input.statuses && input.statuses.length >= 2) {
          repository.createCustomStatuses(id, input.statuses)
        } else {
          repository.createDefaultStatuses(id)
        }

        const project = repository.getProject(id)
        if (!project) {
          throw new Error('Project not found after create')
        }

        const events: TasksDomainEvent[] = [{ kind: 'projectCreated', payload: { project } }]
        return { result: { success: true, project }, events }
      })
    },

    async updateProject(input: ProjectUpdateInput) {
      return commit(() => {
        const { id, statuses, ...metadataUpdates } = input
        const project = repository.updateProject(id, metadataUpdates)
        if (!project) {
          return {
            result: { success: false, project: null, error: 'Project not found' },
            events: []
          }
        }

        if (statuses) {
          repository.reconcileProjectStatuses(id, statuses)
        }

        const resolvedProject = repository.getProject(id)
        if (!resolvedProject) {
          throw new Error('Project not found after update')
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'projectUpdated',
            payload: {
              id,
              project: resolvedProject,
              changedFields: [...Object.keys(metadataUpdates), ...(statuses ? ['statuses'] : [])]
            }
          }
        ]
        return { result: { success: true, project: resolvedProject }, events }
      })
    },

    async deleteProject(id: string) {
      return commit(() => {
        const snapshot = repository.getProject(id)
        // SQLite cascades this project's tasks away locally, but a cascade is
        // invisible to sync: without an explicit tombstone per task the server
        // keeps them alive forever, and every device then re-pulls a task whose
        // project_id no longer resolves — FOREIGN KEY constraint failed on every
        // cycle, item skipped, manifest still sees it server-only, re-pull (#837).
        // The tombstones are events of this write so they commit with the
        // cascade, not one by one after it (#2301).
        // listTasks strips the sync clock; getTask keeps it, and the tombstone
        // is built from the snapshot's clock.
        const cascadedTasks = repository
          .listTasks({ projectId: id, includeCompleted: true, includeArchived: true })
          .map((task) => repository.getTask(task.id) ?? task)
        repository.deleteProject(id)
        const events: TasksDomainEvent[] = [
          { kind: 'projectDeleted', payload: { id, snapshot } },
          ...cascadedTasks.map((task): TasksDomainEvent => ({
            kind: 'taskDeleted',
            payload: { id: task.id, snapshot: task }
          }))
        ]
        return { result: { success: true }, events }
      })
    },

    async linkItemToProject(input: ProjectLinkItemInput) {
      return commit(() => {
        // Validate before inserting — project_links.project_id carries a FK, so an
        // unknown (or concurrently deleted) project would throw past the structured
        // `{ success: false, error }` response instead of returning it.
        const project = repository.getProject(input.projectId)
        if (!project) {
          return { result: { success: false, error: 'Project not found' }, events: [] }
        }

        const existing = repository.findProjectLink(input.projectId, input.itemType, input.itemId)
        if (!existing) {
          repository.linkItemToProject({
            id: generateId(),
            projectId: input.projectId,
            itemType: input.itemType,
            itemId: input.itemId
          })
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'projectUpdated',
            payload: { id: input.projectId, project, changedFields: ['links'] }
          }
        ]
        return { result: { success: true }, events }
      })
    },

    async unlinkItemFromProject(input: ProjectLinkItemInput) {
      return commit(() => {
        repository.unlinkItemFromProject(input.projectId, input.itemType, input.itemId)

        const project = repository.getProject(input.projectId)
        if (!project) {
          return { result: { success: false, error: 'Project not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'projectUpdated',
            payload: { id: input.projectId, project, changedFields: ['links'] }
          }
        ]
        return { result: { success: true }, events }
      })
    },

    async setProjectLinkPinned(input: ProjectSetLinkPinnedInput) {
      return commit(() => {
        repository.setProjectLinkPinned(input.projectId, input.itemId, input.pinned)

        const project = repository.getProject(input.projectId)
        if (!project) {
          return { result: { success: false, error: 'Project not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'projectUpdated',
            payload: { id: input.projectId, project, changedFields: ['links'] }
          }
        ]
        return { result: { success: true }, events }
      })
    },

    async setProjectHomeNote(input: ProjectSetHomeNoteInput) {
      return commit(() => {
        repository.setProjectHomeNote(input.projectId, input.noteId)

        const project = repository.getProject(input.projectId)
        if (!project) {
          return { result: { success: false, error: 'Project not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'projectUpdated',
            payload: { id: input.projectId, project, changedFields: ['homeNoteId'] }
          }
        ]
        return { result: { success: true, project }, events }
      })
    },

    // A note's links + home-note references only sync because the project payload
    // carries them, so removing them must re-enqueue each affected project through
    // the same projectUpdated event as link/unlink/set-home-note.
    async cleanupProjectLinksForDeletedNote(noteId: string) {
      return commit(() => {
        const fromLinks = repository.deleteProjectLinksForItem('note', noteId)
        const fromHome = repository.clearProjectsHomeNote(noteId)

        const changedByProject = new Map<string, string[]>()
        for (const id of fromLinks) changedByProject.set(id, ['links'])
        for (const id of fromHome) {
          const existing = changedByProject.get(id)
          changedByProject.set(id, existing ? [...existing, 'homeNoteId'] : ['homeNoteId'])
        }

        const events: TasksDomainEvent[] = []
        for (const [projectId, changedFields] of changedByProject) {
          const project = repository.getProject(projectId)
          if (project) {
            events.push({
              kind: 'projectUpdated',
              payload: { id: projectId, project, changedFields }
            })
          }
        }

        return { result: { success: true }, events }
      })
    },

    async archiveProject(id: string) {
      return commit(() => {
        const project = repository.archiveProject(id)
        if (!project) {
          return { result: { success: false, error: 'Project not found' }, events: [] }
        }

        const resolvedProject = repository.getProject(id)
        const events: TasksDomainEvent[] = [
          {
            kind: 'projectUpdated',
            payload: { id, project: resolvedProject ?? project, changedFields: ['archivedAt'] }
          }
        ]
        return { result: { success: true }, events }
      })
    },

    async reorderProjects(projectIds: string[], positions: number[]) {
      return commit(() => {
        repository.reorderProjects(projectIds, positions)

        const events: TasksDomainEvent[] = []
        for (const projectId of projectIds) {
          const project = repository.getProject(projectId)
          if (project) {
            events.push({
              kind: 'projectUpdated',
              payload: { id: projectId, project, changedFields: ['position'] }
            })
          }
        }

        return { result: { success: true }, events }
      })
    },

    async createStatus(input: StatusCreateInput) {
      return commit(() => {
        const status = repository.createStatus({
          id: generateId(),
          projectId: input.projectId,
          name: input.name,
          color: input.color ?? '#6b7280',
          position: repository.getNextStatusPosition(input.projectId),
          isDefault: false,
          isDone: input.isDone ?? false
        })

        const events: TasksDomainEvent[] = [{ kind: 'statusCreated', payload: { status } }]
        return { result: { success: true, status }, events }
      })
    },

    async updateStatus(input: StatusUpdateInput) {
      return commit(() => {
        const { id, ...updates } = input
        const status = repository.updateStatus(id, updates)
        if (!status) {
          return { result: { success: false, error: 'Status not found' }, events: [] }
        }

        const resolvedStatus = repository.getStatus(id) ?? status
        const events: TasksDomainEvent[] = [
          { kind: 'statusUpdated', payload: { status: resolvedStatus } }
        ]
        return { result: { success: true, status: resolvedStatus }, events }
      })
    },

    async deleteStatus(id: string) {
      return commit(() => {
        const status = repository.getStatus(id)
        repository.deleteStatus(id)
        const events: TasksDomainEvent[] = status
          ? [{ kind: 'statusDeleted', payload: { id, projectId: status.projectId } }]
          : []
        return { result: { success: true }, events }
      })
    },

    async reorderStatuses(statusIds: string[], positions: number[]) {
      return commit(() => {
        repository.reorderStatuses(statusIds, positions)
        const events: TasksDomainEvent[] = []
        for (const statusId of statusIds) {
          const status = repository.getStatus(statusId)
          if (status) {
            events.push({ kind: 'statusUpdated', payload: { status } })
          }
        }
        return { result: { success: true }, events }
      })
    }
  }
}
