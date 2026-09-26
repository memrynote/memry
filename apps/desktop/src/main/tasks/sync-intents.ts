import type { TasksDomainEvent } from '@memry/domain-tasks'
import type { SyncIntent } from '../sync/sync-intents'

/**
 * The one place a tasks-domain event becomes a sync obligation (#2301). The
 * intents commit with the row in the domain's unit of work, so a crash can no
 * longer lose a task or project push, a cascaded tombstone included. A delete
 * without a snapshot owes nothing: the adapter needs the snapshot to build it.
 */
export function tasksEventSyncIntents(event: TasksDomainEvent): SyncIntent[] {
  switch (event.kind) {
    case 'taskCreated':
      return [{ type: 'task', itemId: event.payload.task.id, op: 'create', args: [] }]
    case 'taskUpdated':
    case 'taskMoved':
    case 'taskReordered':
      return [
        {
          type: 'task',
          itemId: event.payload.id,
          op: 'update',
          args: [event.payload.changedFields]
        }
      ]
    case 'taskCompleted':
      return [{ type: 'task', itemId: event.payload.id, op: 'update', args: [['completedAt']] }]
    case 'taskDeleted': {
      const { id, snapshot } = event.payload
      return snapshot
        ? [{ type: 'task', itemId: id, op: 'delete', args: [JSON.stringify(snapshot)] }]
        : []
    }
    case 'projectCreated':
      return [{ type: 'project', itemId: event.payload.project.id, op: 'create', args: [] }]
    case 'projectUpdated': {
      const { id, changedFields } = event.payload
      return [
        { type: 'project', itemId: id, op: 'update', args: changedFields ? [changedFields] : [] }
      ]
    }
    case 'projectDeleted': {
      const { id, snapshot } = event.payload
      return snapshot
        ? [{ type: 'project', itemId: id, op: 'delete', args: [JSON.stringify(snapshot)] }]
        : []
    }
    // Same field name updateProject reports when it reconciles statuses.
    case 'statusCreated':
    case 'statusUpdated':
      return [
        {
          type: 'project',
          itemId: event.payload.status.projectId,
          op: 'update',
          args: [['statuses']]
        }
      ]
    case 'statusDeleted':
      return [
        { type: 'project', itemId: event.payload.projectId, op: 'update', args: [['statuses']] }
      ]
  }
}
