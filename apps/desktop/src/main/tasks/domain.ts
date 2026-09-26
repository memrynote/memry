import { createTasksDomain, type TasksDomainPublisher } from '@memry/domain-tasks'
import { createTasksRepository } from '@memry/storage-data'
import * as taskQueries from '@main/database/queries/tasks'
import * as projectQueries from '@main/database/queries/projects'
import type { DataDb } from '../database'
import { commitLocalChange } from '../sync/sync-intents'
import { createLogger } from '../lib/logger'
import { tasksEventSyncIntents } from './sync-intents'

const log = createLogger('TasksDomain')

export function createDesktopTasksDomain(
  db: DataDb,
  publisher: TasksDomainPublisher,
  generateId: () => string
) {
  return createTasksDomain({
    repository: createTasksRepository({
      db,
      taskQueries,
      projectQueries
    }),
    publisher,
    generateId,
    // Row + sync intent in one transaction (#2301); the publisher runs after it.
    unitOfWork: {
      run: (write) =>
        commitLocalChange(db, () => {
          const out = write()
          return { value: out, intents: out.events.flatMap(tasksEventSyncIntents) }
        })
    },
    onPublisherError: (kind, error) => {
      log.warn('Tasks publisher side effect failed after commit', { kind, error })
    }
  })
}
